//! Bounded, versioned ZIP snapshots. Members are read in memory, never extracted.
use crate::{
    protocol::{diagnostics::validate_decimal, session::Result},
    remote::{
        diagnostics::{DiagnosticRun, Gap, StoredDiagnostic},
        server::Remote,
    },
    session::{Library, MAX_LIBRARY_BYTES, MAX_SESSIONS, Session, read_session},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    fs::File,
    io::{BufRead, BufReader, Cursor, Read, Write},
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio_util::sync::CancellationToken;
use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

pub const MAX_BUNDLE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_DIAGNOSTICS_BYTES: usize = 4 * 1024 * 1024;
const MAX_RUNS: usize = 8;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkOrigin {
    #[serde(default)]
    pub source_device_id: Option<String>,
    #[serde(default)]
    pub source_network_id: Option<String>,
    pub recovered: bool,
    pub dropped: u64,
    pub evicted: u64,
    pub syncing: bool,
}
pub struct NetworkSnapshot {
    pub key: String,
    pub filename: String,
    pub session: Arc<Session>,
    pub origin: NetworkOrigin,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunManifest {
    pub key: String,
    pub device_id: String,
    pub run_id: String,
    pub network_key: Option<String>,
    pub accepted: BTreeMap<String, String>,
    pub received: u64,
    pub duplicates: u64,
    pub evicted: u64,
    pub gap_count: u64,
    pub gaps: Vec<Gap>,
}
pub struct RunSnapshot {
    pub meta: RunManifest,
    pub records: Vec<Arc<str>>,
}
#[derive(Default)]
pub struct Bundle {
    pub networks: Vec<NetworkSnapshot>,
    pub runs: Vec<RunSnapshot>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Member {
    file: String,
    sha256: String,
    bytes: u64,
    count: usize,
}
#[derive(Serialize, Deserialize)]
struct NetworkManifest {
    key: String,
    filename: String,
    skipped: usize,
    origin: NetworkOrigin,
    member: Member,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format: String,
    version: u32,
    network_version: u32,
    diagnostics_version: u32,
    networks: Vec<NetworkManifest>,
    runs: Vec<(RunManifest, Member)>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    pub session_id: Option<String>,
    pub run_id: Option<String>,
}

impl RunSnapshot {
    pub fn capture(key: &str, run: &DiagnosticRun) -> Self {
        Self {
            meta: RunManifest {
                key: key.into(),
                device_id: run
                    .original_device_id
                    .as_ref()
                    .unwrap_or(&run.device_id)
                    .clone(),
                run_id: run.run_id.clone(),
                network_key: run.network_key.clone(),
                accepted: run.accepted_strings(),
                received: run.received,
                duplicates: run.duplicates,
                evicted: run.evicted,
                gap_count: run.gap_count,
                gaps: run.gaps.iter().cloned().collect(),
            },
            records: run.events().map(|entry| entry.raw.clone()).collect(),
        }
    }
    fn restore(&self, network_key: Option<String>) -> Result<DiagnosticRun> {
        let m = &self.meta;
        if m.run_id.is_empty()
            || m.run_id.len() > 256
            || m.accepted.len() > 16
            || m.gaps.len() > 64
            || self.records.len() > 2000
            || m.received.checked_sub(m.evicted) != Some(self.records.len() as u64)
        {
            return Err("invalidBundle".into());
        }
        let mut accepted = BTreeMap::new();
        for (emitter, sequence) in &m.accepted {
            validate_decimal(sequence).map_err(|_| "invalidBundle")?;
            if emitter.is_empty() || emitter.len() > 256 {
                return Err("invalidBundle".into());
            }
            accepted.insert(
                emitter.clone(),
                sequence.parse::<u64>().map_err(|_| "invalidBundle")?,
            );
        }
        let mut ids = HashSet::new();
        let mut sequences = HashSet::new();
        let mut bytes = 0;
        let mut events = VecDeque::new();
        for raw in &self.records {
            let stored = StoredDiagnostic::parse(raw).map_err(|_| "invalidBundle")?;
            let e = &stored.event;
            let seq = e.sequence.parse::<u64>().map_err(|_| "invalidBundle")?;
            if e.run_id != m.run_id
                || seq == 0
                || accepted.get(&e.emitter_id).is_none_or(|last| seq > *last)
                || !ids.insert(e.event_id.clone())
                || !sequences.insert((e.emitter_id.clone(), seq))
            {
                return Err("invalidBundle".into());
            }
            bytes += raw.len();
            if bytes > MAX_DIAGNOSTICS_BYTES {
                return Err("bundleTooLarge".into());
            }
            events.push_back(stored);
        }
        let mut recent_gaps = 0_u64;
        for gap in &m.gaps {
            validate_decimal(&gap.from_sequence).map_err(|_| "invalidBundle")?;
            validate_decimal(&gap.to_sequence).map_err(|_| "invalidBundle")?;
            let from = gap
                .from_sequence
                .parse::<u64>()
                .map_err(|_| "invalidBundle")?;
            let to = gap
                .to_sequence
                .parse::<u64>()
                .map_err(|_| "invalidBundle")?;
            if from == 0
                || to < from
                || gap.reason.len() > 128
                || accepted.get(&gap.emitter_id).is_none_or(|last| to > *last)
            {
                return Err("invalidBundle".into());
            }
            recent_gaps = recent_gaps
                .checked_add(to - from + 1)
                .ok_or("invalidBundle")?;
        }
        if recent_gaps > m.gap_count {
            return Err("invalidBundle".into());
        }
        Ok(DiagnosticRun {
            // Import namespaces never match a live device/run's admission key.
            device_id: format!("archive-{}", uuid::Uuid::new_v4()),
            original_device_id: Some(m.device_id.clone()),
            run_id: m.run_id.clone(),
            network_key,
            connection_id: String::new(),
            online: false,
            cancel: CancellationToken::new(),
            accepted,
            events,
            bytes,
            received: m.received,
            duplicates: m.duplicates,
            evicted: m.evicted,
            gap_count: m.gap_count,
            version: 1,
            gaps: m.gaps.clone().into(),
        })
    }
}

pub fn capture(
    library: &Library,
    remote: &Remote,
    scope: Option<&crate::query::Scope>,
) -> Result<Bundle> {
    // Lock order matches normal network/diagnostic operations; never serialize under these locks.
    let mut store = remote.store.lock().map_err(|_| "internalError")?;
    let diagnostics = remote.diagnostics.lock().map_err(|_| "internalError")?;
    let mut bundle = Bundle::default();
    let include_network = |id: &str| match scope {
        None => true,
        Some(crate::query::Scope::Network { id: selected }) => selected == id,
        _ => false,
    };
    for (id, (filename, session)) in &library.sessions {
        if include_network(id) {
            bundle.networks.push(NetworkSnapshot {
                key: id.clone(),
                filename: filename.clone(),
                session: session.clone(),
                origin: library.archives.get(id).cloned().unwrap_or_default(),
            });
        }
    }
    let live_export_budget = if scope.is_some() {
        crate::session::MAX_FILE_BYTES
    } else {
        // 整工作区快照时平均控制单个实时会话冷存并入预算，确保恢复不触发 libraryFull
        crate::session::MAX_FILE_BYTES.min(MAX_LIBRARY_BYTES / 4)
    };
    for (id, session) in &mut store.sessions {
        if include_network(id) {
            let merged = session.snapshot_session(true, live_export_budget);
            bundle.networks.push(NetworkSnapshot {
                key: id.clone(),
                filename: merged
                    .header
                    .name
                    .clone()
                    .unwrap_or_else(|| "Network".into()),
                session: Arc::new(merged),
                origin: NetworkOrigin {
                    source_device_id: Some(session.device_id.clone()),
                    source_network_id: Some(session.network_id.clone()),
                    dropped: session.dropped,
                    evicted: session.evicted,
                    syncing: session.staging.is_some(),
                    recovered: false,
                },
            });
        }
    }
    for (id, run) in &diagnostics.runs {
        let include = match scope {
            None => true,
            Some(crate::query::Scope::Network { id }) => run.network_key.as_ref() == Some(id),
            Some(crate::query::Scope::Diagnostic { id: selected }) => id == selected,
        };
        if include {
            bundle.runs.push(RunSnapshot::capture(id, run));
        }
    }
    if scope.is_some() && bundle.networks.is_empty() && bundle.runs.is_empty() {
        return Err("sessionNotFound".into());
    }
    let network_keys: HashSet<_> = bundle.networks.iter().map(|n| n.key.clone()).collect();
    for run in &mut bundle.runs {
        if run
            .meta
            .network_key
            .as_ref()
            .is_some_and(|key| !network_keys.contains(key))
        {
            run.meta.network_key = None;
        }
    }
    bundle.networks.sort_by(|a, b| a.key.cmp(&b.key));
    bundle.runs.sort_by(|a, b| a.meta.key.cmp(&b.meta.key));
    Ok(bundle)
}

fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err("cancelled".into())
    } else {
        Ok(())
    }
}

pub fn save(path: &Path, bundle: &Bundle) -> Result<()> {
    if bundle.networks.len() > MAX_SESSIONS || bundle.runs.len() > MAX_RUNS {
        return Err("bundleTooLarge".into());
    }
    // A snapshot produced here must fit into an empty offline library on recovery.
    if bundle
        .networks
        .iter()
        .map(|network| network.session.raw_bytes)
        .sum::<usize>()
        > MAX_LIBRARY_BYTES
    {
        return Err("libraryFull".into());
    }
    let network_bytes: usize = bundle
        .networks
        .iter()
        .map(|network| {
            network.session.raw_header.len()
                + 1
                + network
                    .session
                    .entries
                    .iter()
                    .map(|entry| entry.raw.len() + 1)
                    .sum::<usize>()
        })
        .sum();
    let diagnostic_bytes: usize = bundle
        .runs
        .iter()
        .flat_map(|run| &run.records)
        .map(|raw| raw.len() + 1)
        .sum();
    if network_bytes as u64 + diagnostic_bytes as u64 > MAX_BUNDLE_BYTES - 1024 * 1024 {
        return Err("bundleTooLarge".into());
    }
    let mut manifest = Manifest {
        format: "peekbundle".into(),
        version: 1,
        network_version: 1,
        diagnostics_version: 1,
        networks: vec![],
        runs: vec![],
    };
    let mut temp = tempfile::Builder::new()
        .prefix(".peek-write-")
        .tempfile_in(path.parent().ok_or("invalidPath")?)
        .map_err(|e| e.to_string())?;
    let mut total = 0_u64;
    {
        let mut zip = ZipWriter::new(temp.as_file_mut());
        let options = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o600);
        let mut write_member = |file: String, bytes: Vec<u8>, count: usize| -> Result<Member> {
            total = total
                .checked_add(bytes.len() as u64)
                .ok_or("bundleTooLarge")?;
            if total > MAX_BUNDLE_BYTES - 1024 * 1024 {
                return Err("bundleTooLarge".into());
            }
            zip.start_file(&file, options)
                .map_err(|_| "bundleWriteFailed")?;
            zip.write_all(&bytes).map_err(|_| "bundleWriteFailed")?;
            Ok(Member {
                file,
                bytes: bytes.len() as u64,
                sha256: hash(&bytes),
                count,
            })
        };
        for (index, network) in bundle.networks.iter().enumerate() {
            if network.session.header.format_version != 1 {
                return Err("unsupportedBundle".into());
            }
            let mut bytes = vec![];
            network.session.write(&mut bytes)?;
            let member = write_member(
                format!("network/{index}.peek"),
                bytes,
                network.session.entries.len(),
            )?;
            manifest.networks.push(NetworkManifest {
                key: network.key.clone(),
                filename: network.filename.clone(),
                skipped: network.session.skipped,
                origin: network.origin.clone(),
                member,
            });
        }
        for (index, run) in bundle.runs.iter().enumerate() {
            let mut bytes = vec![];
            for raw in &run.records {
                writeln!(bytes, "{raw}").map_err(|_| "bundleWriteFailed")?;
            }
            let member = write_member(
                format!("diagnostics/{index}.jsonl"),
                bytes,
                run.records.len(),
            )?;
            manifest.runs.push((run.meta.clone(), member));
        }
        zip.start_file("manifest.json", options)
            .map_err(|_| "bundleWriteFailed")?;
        serde_json::to_writer(&mut zip, &manifest).map_err(|_| "bundleWriteFailed")?;
        zip.finish().map_err(|_| "bundleWriteFailed")?;
    }
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.error.to_string())?;
    Ok(())
}

fn member(zip: &mut ZipArchive<File>, meta: &Member, cancel: &AtomicBool) -> Result<Vec<u8>> {
    let mut file = zip.by_name(&meta.file).map_err(|_| "invalidBundle")?;
    if file.size() != meta.bytes || meta.bytes > MAX_BUNDLE_BYTES {
        return Err("invalidBundle".into());
    }
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 64 * 1024];
    loop {
        cancelled(cancel)?;
        let count = file.read(&mut chunk).map_err(|_| "invalidBundle")?;
        if count == 0 {
            break;
        }
        if bytes.len() as u64 + count as u64 > meta.bytes {
            return Err("bundleTooLarge".into());
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    if bytes.len() as u64 != meta.bytes || hash(&bytes) != meta.sha256 {
        return Err("invalidBundle".into());
    }
    Ok(bytes)
}

pub fn open(path: &Path, cancel: &AtomicBool, mut progress: impl FnMut(usize)) -> Result<Bundle> {
    cancelled(cancel)?;
    let file = File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_BUNDLE_BYTES {
        return Err("bundleTooLarge".into());
    }
    let mut zip = ZipArchive::new(file).map_err(|_| "invalidBundle")?;
    if zip.len() > 1 + MAX_SESSIONS + MAX_RUNS {
        return Err("bundleTooLarge".into());
    }
    let mut names = HashSet::new();
    let mut expanded = 0_u64;
    for index in 0..zip.len() {
        let file = zip.by_index(index).map_err(|_| "invalidBundle")?;
        if !names.insert(file.name().map_err(|_| "invalidBundle")?.into_owned()) || file.is_dir() {
            return Err("invalidBundle".into());
        }
        expanded = expanded.checked_add(file.size()).ok_or("bundleTooLarge")?;
        if expanded > MAX_BUNDLE_BYTES {
            return Err("bundleTooLarge".into());
        }
    }
    let manifest: Manifest = {
        let mut bytes = Vec::new();
        let file = zip.by_name("manifest.json").map_err(|_| "invalidBundle")?;
        if file.size() > 1024 * 1024 {
            return Err("bundleTooLarge".into());
        }
        file.take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "invalidBundle")?;
        serde_json::from_slice(&bytes).map_err(|_| "invalidBundle")?
    };
    if manifest.format != "peekbundle"
        || manifest.version != 1
        || manifest.network_version != 1
        || manifest.diagnostics_version != 1
    {
        return Err("unsupportedBundle".into());
    }
    if manifest.networks.len() > MAX_SESSIONS
        || manifest.runs.len() > MAX_RUNS
        || names.len() != 1 + manifest.networks.len() + manifest.runs.len()
    {
        return Err("invalidBundle".into());
    }
    let mut keys = HashSet::new();
    let mut bundle = Bundle::default();
    let mut total = 0;
    for (index, network) in manifest.networks.into_iter().enumerate() {
        if network.member.file != format!("network/{index}.peek")
            || !keys.insert(network.key.clone())
            || network.filename.len() > 1024
        {
            return Err("invalidBundle".into());
        }
        if network.member.bytes > crate::session::MAX_FILE_BYTES as u64 {
            return Err("bundleTooLarge".into());
        }
        let bytes = member(&mut zip, &network.member, cancel)?;
        let mut session = read_session(Cursor::new(&bytes), cancel, |_| {})?;
        if session.entries.len() != network.member.count
            || session.skipped != 0
            || session.header.format_version != 1
        {
            return Err("invalidBundle".into());
        }
        session.skipped = network.skipped;
        total += bytes.len();
        progress(total);
        bundle.networks.push(NetworkSnapshot {
            key: network.key,
            filename: network.filename,
            session: Arc::new(session),
            origin: network.origin,
        });
    }
    let mut run_keys = HashSet::new();
    for (index, (meta, member_meta)) in manifest.runs.into_iter().enumerate() {
        if member_meta.file != format!("diagnostics/{index}.jsonl")
            || !run_keys.insert(meta.key.clone())
            || meta
                .network_key
                .as_ref()
                .is_some_and(|key| !keys.contains(key))
        {
            return Err("invalidBundle".into());
        }
        if member_meta.bytes > (MAX_DIAGNOSTICS_BYTES + 2000) as u64 {
            return Err("bundleTooLarge".into());
        }
        let bytes = member(&mut zip, &member_meta, cancel)?;
        if bytes.len() > MAX_DIAGNOSTICS_BYTES + 2000 {
            return Err("bundleTooLarge".into());
        }
        let text = std::str::from_utf8(&bytes).map_err(|_| "invalidBundle")?;
        let records: Vec<Arc<str>> = text.lines().map(Arc::from).collect();
        if records.len() != member_meta.count {
            return Err("invalidBundle".into());
        }
        let run = RunSnapshot { meta, records };
        run.restore(None)?;
        total += bytes.len();
        progress(total);
        bundle.runs.push(run);
    }
    Ok(bundle)
}

pub fn install(
    library: &mut Library,
    remote: &Remote,
    bundle: Bundle,
    recovered: bool,
) -> Result<Imported> {
    let mut diagnostics = remote.diagnostics.lock().map_err(|_| "internalError")?;
    let bytes: usize = library.sessions.values().map(|(_, s)| s.raw_bytes).sum();
    if library.sessions.len() + bundle.networks.len() > MAX_SESSIONS
        || bytes
            + bundle
                .networks
                .iter()
                .map(|n| n.session.raw_bytes)
                .sum::<usize>()
            > MAX_LIBRARY_BYTES
        || diagnostics.runs.len() + bundle.runs.len() > MAX_RUNS
    {
        return Err("libraryFull".into());
    }
    let mut mapping = HashMap::new();
    for network in &bundle.networks {
        mapping.insert(
            network.key.clone(),
            format!("file-archive-{}", uuid::Uuid::new_v4()),
        );
    }
    // Prepare every run before committing any session; malformed imports leave the workspace intact.
    let prepared = bundle
        .runs
        .iter()
        .map(|run| {
            let bound = run
                .meta
                .network_key
                .as_ref()
                .map(|key| mapping.get(key).cloned().ok_or("invalidBundle"))
                .transpose()?;
            Ok((
                format!("diagnostic-archive-{}", uuid::Uuid::new_v4()),
                run.restore(bound)?,
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    let first_network = bundle
        .networks
        .first()
        .and_then(|n| mapping.get(&n.key))
        .cloned();
    let first_run = prepared.first().map(|(id, _)| id.clone());
    for mut network in bundle.networks {
        let id = mapping[&network.key].clone();
        network.origin.recovered = recovered;
        library.archives.insert(id.clone(), network.origin);
        library
            .sessions
            .insert(id, (network.filename, network.session));
    }
    for (id, run) in prepared {
        diagnostics.runs.insert(id, run);
    }
    drop(diagnostics);
    remote.changed();
    Ok(Imported {
        session_id: first_network,
        run_id: first_run,
    })
}

/// JSONL imports keep independent provenance, even when event IDs match live data.
pub fn open_jsonl(path: &Path, cancel: &AtomicBool) -> Result<Bundle> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > (MAX_RUNS * MAX_DIAGNOSTICS_BYTES) as u64
    {
        return Err("bundleTooLarge".into());
    }
    let mut reader = BufReader::new(file);
    let mut groups: BTreeMap<String, RunSnapshot> = BTreeMap::new();
    let mut total = 0;
    loop {
        cancelled(cancel)?;
        let mut line = String::new();
        let count = reader
            .by_ref()
            .take(128 * 1024 + 2)
            .read_line(&mut line)
            .map_err(|_| "invalidBundle")?;
        if count == 0 {
            break;
        }
        total += count;
        if total > MAX_RUNS * MAX_DIAGNOSTICS_BYTES || count > 128 * 1024 + 1 {
            return Err("bundleTooLarge".into());
        }
        let raw = line.trim_end_matches(['\r', '\n']);
        if raw.is_empty() {
            continue;
        }
        let stored = StoredDiagnostic::parse(raw).map_err(|_| "invalidBundle")?;
        let e = &stored.event;
        if !groups.contains_key(&e.run_id) && groups.len() >= MAX_RUNS {
            return Err("bundleTooLarge".into());
        }
        let run = groups
            .entry(e.run_id.clone())
            .or_insert_with(|| RunSnapshot {
                meta: RunManifest {
                    key: e.run_id.clone(),
                    device_id: "imported-jsonl".into(),
                    run_id: e.run_id.clone(),
                    network_key: None,
                    accepted: BTreeMap::new(),
                    received: 0,
                    duplicates: 0,
                    evicted: 0,
                    gap_count: 0,
                    gaps: vec![],
                },
                records: vec![],
            });
        let sequence = e.sequence.parse::<u64>().map_err(|_| "invalidBundle")?;
        let last = run
            .meta
            .accepted
            .entry(e.emitter_id.clone())
            .or_insert_with(|| "0".into());
        if sequence > last.parse::<u64>().map_err(|_| "invalidBundle")? {
            *last = sequence.to_string();
        }
        run.meta.received += 1;
        run.records.push(Arc::from(raw));
        if run.records.len() > 2000 {
            return Err("bundleTooLarge".into());
        }
    }
    let bundle = Bundle {
        networks: vec![],
        runs: groups.into_values().collect(),
    };
    if bundle.runs.is_empty() {
        return Err("invalidBundle".into());
    }
    for run in &bundle.runs {
        run.restore(None)?;
    }
    Ok(bundle)
}
