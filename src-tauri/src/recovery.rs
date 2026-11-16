//! Two atomic snapshot slots; live protocol ACKs do not depend on this cache.
use crate::{
    archive::{self, Bundle, Imported},
    protocol::session::Result,
    remote::server::Remote,
    session::Library,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{File, OpenOptions},
    path::PathBuf,
    sync::atomic::AtomicBool,
    time::UNIX_EPOCH,
};

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryStatus {
    pub enabled: bool,
    pub available: bool,
    pub pending: bool,
    pub restored: bool,
    pub used_backup: bool,
    pub updated_at: Option<u64>,
    pub bytes: u64,
    pub error: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Settings {
    enabled: bool,
}
#[derive(Default)]
pub struct Recovery {
    directory: PathBuf,
    lock: Option<File>,
    pub status: RecoveryStatus,
    newest: Option<usize>,
    stamp: Option<String>,
}
pub struct PreparedWorkspace {
    bundle: Bundle,
    stamp: String,
}
pub struct PendingRecovery {
    bundle: Bundle,
    slot: usize,
    backup: bool,
}
impl Recovery {
    pub fn load(directory: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&directory).map_err(|_| "recoveryUnavailable")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| "recoveryUnavailable")?;
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(directory.join("workspace.lock"))
            .map_err(|_| "recoveryUnavailable")?;
        lock.try_lock().map_err(|_| "recoveryInUse")?;
        // Only our own abandoned temporary writes inside the managed directory.
        for entry in std::fs::read_dir(&directory)
            .map_err(|_| "recoveryUnavailable")?
            .flatten()
        {
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with(".peek-write-")
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
        let mut result = Self {
            directory,
            lock: Some(lock),
            ..Self::default()
        };
        let settings = result.directory.join("settings.json");
        if settings.exists() {
            match settings
                .metadata()
                .ok()
                .filter(|meta| meta.len() <= 1024)
                .and_then(|_| std::fs::read(&settings).ok())
                .and_then(|data| serde_json::from_slice::<Settings>(&data).ok())
            {
                Some(settings) => result.status.enabled = settings.enabled,
                None => result.status.error = Some("recoverySettingsInvalid".into()),
            }
        }
        let slots = result.slots();
        result.newest = slots.first().map(|(slot, _, _)| *slot);
        result.status.available = !slots.is_empty();
        result.status.pending = result.status.available;
        result.update_size();
        Ok(result)
    }
    fn path(&self, slot: usize) -> PathBuf {
        self.directory.join(format!("workspace-{slot}.peekbundle"))
    }
    fn slots(&self) -> Vec<(usize, std::time::SystemTime, u64)> {
        let mut slots = (0..2)
            .filter_map(|slot| {
                let meta = self.path(slot).metadata().ok()?;
                Some((slot, meta.modified().ok()?, meta.len()))
            })
            .collect::<Vec<_>>();
        slots.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.0.cmp(&a.0)));
        slots
    }
    fn update_size(&mut self) {
        let slots = self.slots();
        self.status.bytes = slots.iter().map(|(_, _, bytes)| bytes).sum();
        self.status.updated_at = slots
            .first()
            .and_then(|(_, time, _)| time.duration_since(UNIX_EPOCH).ok())
            .map(|time| time.as_secs());
    }
    fn ready(&self) -> Result<()> {
        if self.lock.is_none() {
            return Err(self
                .status
                .error
                .clone()
                .unwrap_or_else(|| "recoveryUnavailable".into()));
        }
        Ok(())
    }
    pub fn set_enabled(&mut self, enabled: bool) -> Result<RecoveryStatus> {
        self.ready()?;
        crate::export::atomic(&self.directory.join("settings.json"), |writer| {
            serde_json::to_writer(writer, &Settings { enabled })
                .map_err(|_| "recoveryUnavailable".into())
        })?;
        self.status.enabled = enabled;
        self.status.error = None;
        Ok(self.status.clone())
    }
    /// Does not remove either slot. The next new snapshot may replace the older one.
    pub fn start_new(&mut self) -> Result<RecoveryStatus> {
        self.ready()?;
        self.status.pending = false;
        self.status.error = None;
        self.stamp = None;
        Ok(self.status.clone())
    }
    pub fn checkpoint(&mut self, bundle: &Bundle) -> Result<()> {
        self.ready()?;
        if self.status.pending {
            return Err("recoveryPending".into());
        }
        if bundle.networks.is_empty() && bundle.runs.is_empty() {
            return Err("nothingToRecover".into());
        }
        let target = 1 - self.newest.unwrap_or(1);
        archive::save(&self.path(target), bundle)?;
        self.newest = Some(target);
        self.status.available = true;
        self.status.error = None;
        self.status.used_backup = false;
        self.update_size();
        Ok(())
    }
    pub fn save_workspace(
        &mut self,
        library: &Library,
        remote: &Remote,
        force: bool,
    ) -> Result<()> {
        let prepared = self.prepare_workspace(library, remote, force)?;
        self.commit_workspace(prepared)
    }
    /// Capture under workspace locks; callers release those locks before commit.
    pub fn prepare_workspace(
        &self,
        library: &Library,
        remote: &Remote,
        force: bool,
    ) -> Result<Option<PreparedWorkspace>> {
        self.ready()?;
        if !force && (!self.status.enabled || self.status.pending) {
            return Ok(None);
        }
        if self.status.pending {
            return Err("recoveryPending".into());
        }
        let mut ids = library.sessions.keys().collect::<Vec<_>>();
        ids.sort();
        let stamp = format!("{ids:?}:{}", *remote.changes.borrow());
        if !force && self.stamp.as_ref() == Some(&stamp) {
            return Ok(None);
        }
        let bundle = archive::capture(library, remote, None)?;
        // Empty workspaces never overwrite a recoverable snapshot.
        if bundle.networks.is_empty() && bundle.runs.is_empty() {
            return Ok(None);
        }
        Ok(Some(PreparedWorkspace { bundle, stamp }))
    }
    pub fn commit_workspace(&mut self, prepared: Option<PreparedWorkspace>) -> Result<()> {
        if let Some(prepared) = prepared {
            self.checkpoint(&prepared.bundle)?;
            self.stamp = Some(prepared.stamp);
        }
        Ok(())
    }
    pub fn restore(&mut self, library: &mut Library, remote: &Remote) -> Result<Imported> {
        let pending = self.read_pending()?;
        self.apply_pending(library, remote, pending)
    }
    /// Read/decompress/validate without holding a library mutex.
    pub fn read_pending(&self) -> Result<PendingRecovery> {
        self.ready()?;
        if !self.status.pending {
            return Err("recoveryNotPending".into());
        }
        let slots = self.slots();
        let mut valid = None;
        for (position, (slot, _, _)) in slots.into_iter().enumerate() {
            if let Ok(bundle) = archive::open(&self.path(slot), &AtomicBool::new(false), |_| {}) {
                valid = Some((slot, position, bundle));
                break;
            }
        }
        let (slot, position, bundle) = valid.ok_or("recoveryCorrupt")?;
        Ok(PendingRecovery {
            bundle,
            slot,
            backup: position > 0,
        })
    }
    pub fn apply_pending(
        &mut self,
        library: &mut Library,
        remote: &Remote,
        pending: PendingRecovery,
    ) -> Result<Imported> {
        if !self.status.pending {
            return Err("recoveryNotPending".into());
        }
        let imported = archive::install(library, remote, pending.bundle, true)?;
        self.newest = Some(pending.slot);
        self.status.pending = false;
        self.status.restored = true;
        self.status.used_backup = pending.backup;
        self.status.error = None;
        self.stamp = None;
        Ok(imported)
    }
}
