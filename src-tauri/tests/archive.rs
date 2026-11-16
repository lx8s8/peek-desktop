use peek_desktop_lib::{
    archive::{self, Bundle, NetworkOrigin, NetworkSnapshot, RunManifest, RunSnapshot},
    query::{ReviewQuery, Scope},
    remote::server::Remote,
    session::{Library, MAX_SESSIONS},
    storage,
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::Path,
    sync::{Arc, atomic::AtomicBool},
};

fn sample() -> Bundle {
    let session = storage::open(
        Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/upstream/sessions/basic.peek"
        )),
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap();
    let id = &session.entries[0].row.id;
    let record = format!(
        r##"{{"eventId":"event-5","runId":"run","emitterId":"main","sequence":"5","occurredAt":"2026-11-13T00:00:00Z","kind":"exception","level":"error","source":"synthetic","message":"中文😀","exception":{{"stackTrace":"#0 original\n#1 caller"}},"relatedNetworkEntryId":"{id}","unknown":900719925474099312345,"duplicate":1,"duplicate":2}}"##
    );
    Bundle {
        networks: vec![NetworkSnapshot {
            key: "network-key".into(),
            filename: "synthetic.peek".into(),
            session: Arc::new(session),
            origin: NetworkOrigin {
                source_device_id: Some("original-device".into()),
                source_network_id: Some("original-network".into()),
                dropped: 4,
                evicted: 7,
                syncing: true,
                recovered: false,
            },
        }],
        runs: vec![RunSnapshot {
            meta: RunManifest {
                key: "diagnostic-key".into(),
                device_id: "original-device".into(),
                run_id: "run".into(),
                network_key: Some("network-key".into()),
                accepted: BTreeMap::from([("main".into(), "5".into())]),
                received: 3,
                duplicates: 2,
                evicted: 2,
                gap_count: 2,
                gaps: vec![peek_desktop_lib::remote::diagnostics::Gap {
                    emitter_id: "main".into(),
                    from_sequence: "3".into(),
                    to_sequence: "4".into(),
                    reason: "syntheticGap".into(),
                }],
            },
            records: vec![Arc::from(record)],
        }],
    }
}
fn rewrite(path: &Path, mutate: impl Fn(&str, Vec<u8>) -> (String, Vec<u8>)) {
    let mut archive = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
    let mut members = vec![];
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).unwrap();
        let name = file.name().unwrap().into_owned();
        let mut bytes = vec![];
        file.read_to_end(&mut bytes).unwrap();
        members.push(mutate(&name, bytes));
    }
    drop(archive);
    let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
    for (name, bytes) in members {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&bytes).unwrap();
    }
    zip.finish().unwrap();
}
#[test]
fn archive_roundtrip_preserves_raw_data_gaps_binding_and_independent_import_identity() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("session.peekbundle");
    let bundle = sample();
    archive::save(&path, &bundle).unwrap();
    let loaded = archive::open(&path, &AtomicBool::new(false), |_| {}).unwrap();
    assert_eq!(loaded.runs[0].records[0], bundle.runs[0].records[0]);
    assert_eq!(
        loaded.networks[0].session.raw_header,
        bundle.networks[0].session.raw_header
    );
    for (a, b) in loaded.networks[0]
        .session
        .entries
        .iter()
        .zip(&bundle.networks[0].session.entries)
    {
        assert_eq!(a.raw, b.raw);
    }
    let remote = Remote::default();
    let mut library = Library::default();
    let first = archive::install(&mut library, &remote, loaded, true).unwrap();
    let id = first.session_id.unwrap();
    let run_id = first.run_id.unwrap();
    assert!(library.archives[&id].recovered);
    assert_eq!(library.archives[&id].evicted, 7);
    let snapshot = remote.snapshot().unwrap();
    let run = &snapshot.diagnostic_runs[0];
    assert!(!run.online);
    assert_ne!(run.device_id, "original-device");
    assert_eq!(run.network_session_key.as_ref(), Some(&id));
    assert_eq!((run.count, run.evicted, run.gap_count), (1, 2, 2));
    assert_eq!(
        &*remote.diagnostic_detail(&run_id, "event-5").unwrap(),
        &*bundle.runs[0].records[0]
    );
    let reexported = archive::capture(&library, &remote, None).unwrap();
    assert_eq!(reexported.runs[0].meta.device_id, "original-device");
    assert_eq!(
        reexported.networks[0].origin.source_network_id.as_deref(),
        Some("original-network")
    );
    let session = library.get(&id).unwrap();
    let timeline = serde_json::to_value(
        remote
            .timeline(
                &Scope::Network { id: id.clone() },
                session.entries.iter().map(|e| e.row.clone()).collect(),
                &ReviewQuery {
                    limit: 300,
                    ..Default::default()
                },
            )
            .unwrap(),
    )
    .unwrap();
    let exception = timeline["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["kind"] == "exception")
        .unwrap();
    assert_eq!(exception["association"], "explicit");
    let again = archive::install(
        &mut library,
        &remote,
        archive::open(&path, &AtomicBool::new(false), |_| {}).unwrap(),
        false,
    )
    .unwrap();
    assert_ne!(again.session_id.as_ref(), Some(&id));
    assert_ne!(again.run_id.as_ref(), Some(&run_id));
    assert_eq!(remote.snapshot().unwrap().diagnostic_runs.len(), 2);
}
#[test]
fn corrupt_members_unknown_versions_and_unsafe_member_names_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.peekbundle");
    archive::save(&path, &sample()).unwrap();
    rewrite(&path, |name, mut bytes| {
        if name.ends_with(".jsonl") {
            bytes.push(b' ');
        }
        (name.into(), bytes)
    });
    assert!(archive::open(&path, &AtomicBool::new(false), |_| {}).is_err());
    archive::save(&path, &sample()).unwrap();
    rewrite(&path, |name, bytes| {
        if name == "manifest.json" {
            let mut value: Value = serde_json::from_slice(&bytes).unwrap();
            value["version"] = 99.into();
            (name.into(), serde_json::to_vec(&value).unwrap())
        } else {
            (name.into(), bytes)
        }
    });
    assert_eq!(
        archive::open(&path, &AtomicBool::new(false), |_| {})
            .err()
            .unwrap(),
        "unsupportedBundle"
    );
    archive::save(&path, &sample()).unwrap();
    rewrite(&path, |name, bytes| {
        if name == "network/0.peek" {
            (String::from("../outside.peek"), bytes)
        } else {
            (name.into(), bytes)
        }
    });
    assert!(archive::open(&path, &AtomicBool::new(false), |_| {}).is_err());
    assert!(!dir.path().join("outside.peek").exists());
    assert_eq!(
        archive::open(&path, &AtomicBool::new(true), |_| {})
            .err()
            .unwrap(),
        "cancelled"
    );
}
#[test]
fn capacity_and_bad_run_fail_before_any_session_is_installed() {
    let remote = Remote::default();
    let mut library = Library::default();
    for _ in 0..MAX_SESSIONS {
        library
            .insert(
                "existing.peek".into(),
                (*sample().networks[0].session).clone(),
            )
            .unwrap();
    }
    assert!(archive::install(&mut library, &remote, sample(), false).is_err());
    assert_eq!(library.sessions.len(), MAX_SESSIONS);
    assert!(remote.snapshot().unwrap().diagnostic_runs.is_empty());
    let mut library = Library::default();
    let mut invalid = sample();
    invalid.runs[0]
        .meta
        .accepted
        .insert("main".into(), "4".into());
    assert!(archive::install(&mut library, &remote, invalid, false).is_err());
    assert!(library.sessions.is_empty());
}
#[test]
fn jsonl_import_stays_independent_and_rejects_duplicates_and_bad_lines_atomically() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("selected.jsonl");
    let bundle = sample();
    std::fs::write(&path, format!("{}\n", bundle.runs[0].records[0])).unwrap();
    let imported = archive::open_jsonl(&path, &AtomicBool::new(false)).unwrap();
    assert!(imported.runs[0].meta.network_key.is_none());
    assert_eq!(imported.runs[0].records[0], bundle.runs[0].records[0]);
    std::fs::write(&path, format!("{0}\n{0}\n", bundle.runs[0].records[0])).unwrap();
    assert!(archive::open_jsonl(&path, &AtomicBool::new(false)).is_err());
    std::fs::write(&path, format!("{}\nnot-json\n", bundle.runs[0].records[0])).unwrap();
    assert!(archive::open_jsonl(&path, &AtomicBool::new(false)).is_err());
}
#[test]
fn failed_archive_save_preserves_existing_destination() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.peekbundle");
    std::fs::write(&path, "old").unwrap();
    let mut bundle = sample();
    Arc::make_mut(&mut bundle.networks[0].session)
        .header
        .format_version = 2;
    assert!(archive::save(&path, &bundle).is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "old");
}
