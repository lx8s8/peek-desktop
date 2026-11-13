use crate::{
    protocol::session::Result,
    session::{MAX_FILE_BYTES, Session, read_session},
};
use std::{
    fs::File,
    io::{BufReader, BufWriter, Write},
    path::Path,
    sync::atomic::AtomicBool,
};

pub fn open(path: &Path, cancel: &AtomicBool, progress: impl FnMut(usize)) -> Result<Session> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_FILE_BYTES as u64 {
        return Err("fileTooLarge".into());
    }
    read_session(BufReader::new(file), cancel, progress)
}

/// Write in the destination directory, then atomically replace the chosen file.
pub fn save(path: &Path, session: &Session) -> Result<()> {
    let parent = path.parent().ok_or("invalidPath")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    {
        let mut writer = BufWriter::new(temp.as_file_mut());
        session.write(&mut writer)?;
        writer.flush().map_err(|e| e.to_string())?;
    }
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.error.to_string())?;
    Ok(())
}

pub fn save_diagnostics(path: &Path, records: &[std::sync::Arc<str>]) -> Result<()> {
    let parent = path.parent().ok_or("invalidPath")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    {
        let mut writer = BufWriter::new(temp.as_file_mut());
        for record in records {
            writeln!(writer, "{record}").map_err(|e| e.to_string())?;
        }
        writer.flush().map_err(|e| e.to_string())?;
    }
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.error.to_string())?;
    Ok(())
}
