//! Disposable real listener for native client QA. Never reads the system vault.
use peek_desktop_lib::{
    protocol::session::Result,
    remote::{pairing::SecretVault, server::Remote},
};
use std::{
    io,
    sync::{Arc, Mutex},
};

#[derive(Default)]
struct MemoryVault(Mutex<Option<String>>);
impl SecretVault for MemoryVault {
    fn read(&self) -> Result<Option<String>> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn write(&self, value: &str) -> Result<()> {
        *self.0.lock().unwrap() = Some(value.into());
        Ok(())
    }
}

#[tokio::main]
async fn main() {
    let remote = Arc::new(Remote::with_vault(Arc::new(MemoryVault::default())));
    let snapshot = remote
        .start("0.0.0.0".into(), 0, true)
        .await
        .expect("start disposable listener");
    let pairing = remote.issue_code(true).await.unwrap().pairing.unwrap();
    println!(
        "Disposable native QA only. mDNS={} port={} code={}. Press Enter to stop.",
        snapshot.listener.mdns,
        snapshot.listener.port,
        pairing.code.unwrap()
    );
    tokio::task::spawn_blocking(|| {
        let mut line = String::new();
        io::stdin().read_line(&mut line).unwrap();
    })
    .await
    .unwrap();
    remote.stop().await.unwrap();
}
