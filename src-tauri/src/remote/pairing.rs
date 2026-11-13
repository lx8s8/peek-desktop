use crate::protocol::session::Result;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use subtle::ConstantTimeEq;
use uuid::Uuid;

const MAX_DEVICES: usize = 4;
const CODE_LIFETIME: u64 = 180;

/// Only the platform adapter handles persisted secrets. Tests inject an isolated vault.
pub trait SecretVault: Send + Sync {
    fn read(&self) -> Result<Option<String>>;
    fn write(&self, value: &str) -> Result<()>;
}

pub struct SystemVault;
impl SecretVault for SystemVault {
    fn read(&self) -> Result<Option<String>> {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            let entry = keyring::Entry::new("local.peek.desktop", "pairings-v1")
                .map_err(|_| "credentialsUnavailable")?;
            match entry.get_password() {
                Ok(value) => Ok(Some(value)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err("credentialsUnavailable".into()),
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        Err("unsupportedCredentialStore".into())
    }

    fn write(&self, value: &str) -> Result<()> {
        if value.len() > 2400 {
            return Err("pairingCapacity".into());
        }
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            keyring::Entry::new("local.peek.desktop", "pairings-v1")
                .map_err(|_| "credentialsUnavailable")?
                .set_password(value)
                .map_err(|_| "credentialsUnavailable".into())
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        Err("unsupportedCredentialStore".into())
    }
}

// Deliberately no Debug or public serialization of credential-bearing structures.
#[derive(Clone, Serialize, Deserialize)]
struct Registry {
    version: u8,
    server_id: String,
    devices: Vec<Device>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Device {
    id: String,
    name: String,
    digest: [u8; 32],
    diagnostics: bool,
}
struct PairingCode {
    text: String,
    expires_at: u64,
    attempts: u8,
    diagnostics: bool,
}

pub struct Pairing {
    vault: Arc<dyn SecretVault>,
    registry: Registry,
    code: Option<PairingCode>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub diagnostics: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingInfo {
    pub server_id: String,
    pub code: Option<String>,
    pub expires_in_seconds: u64,
    pub devices: Vec<DeviceInfo>,
}
pub struct Authorization {
    pub device_id: String,
    pub issued_token: Option<String>,
}

pub fn now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn digest(value: &str) -> [u8; 32] {
    Sha256::digest(value.as_bytes()).into()
}
fn display_name(name: &str) -> String {
    let mut clean = String::new();
    for c in name.chars().filter(|c| !c.is_control()) {
        if clean.len() + c.len_utf8() > 60 {
            break;
        }
        clean.push(c);
    }
    if clean.trim().is_empty() {
        "Flutter App".into()
    } else {
        clean
    }
}

impl Pairing {
    pub fn load(vault: Arc<dyn SecretVault>) -> Result<Self> {
        let registry = if let Some(value) = vault.read()? {
            if value.len() > 2400 {
                return Err("credentialsCorrupt".into());
            }
            let registry: Registry =
                serde_json::from_str(&value).map_err(|_| "credentialsCorrupt")?;
            if registry.version != 1
                || Uuid::parse_str(&registry.server_id).is_err()
                || registry.devices.len() > MAX_DEVICES
                || registry
                    .devices
                    .iter()
                    .any(|d| Uuid::parse_str(&d.id).is_err() || d.name.len() > 60)
            {
                return Err("credentialsCorrupt".into());
            }
            registry
        } else {
            let registry = Registry {
                version: 1,
                server_id: Uuid::new_v4().to_string(),
                devices: Vec::new(),
            };
            vault.write(&serde_json::to_string(&registry).map_err(|_| "internalError")?)?;
            registry
        };
        Ok(Self {
            vault,
            registry,
            code: None,
        })
    }
    pub fn server_id(&self) -> &str {
        &self.registry.server_id
    }
    pub fn issue_code(&mut self, diagnostics: bool, now: u64) -> Result<()> {
        if self.registry.devices.len() >= MAX_DEVICES {
            return Err("pairingCapacity".into());
        }
        self.code = Some(PairingCode {
            text: format!("{:04}", rand::rng().random_range(0..10000)),
            expires_at: now + CODE_LIFETIME,
            attempts: 0,
            diagnostics,
        });
        Ok(())
    }
    pub fn info(&self, now: u64) -> PairingInfo {
        let valid = self.code.as_ref().filter(|code| now < code.expires_at);
        PairingInfo {
            server_id: self.server_id().into(),
            code: valid.map(|c| c.text.clone()),
            expires_in_seconds: valid.map_or(0, |c| c.expires_at - now),
            devices: self
                .registry
                .devices
                .iter()
                .map(|d| DeviceInfo {
                    id: d.id.clone(),
                    name: d.name.clone(),
                    diagnostics: d.diagnostics,
                })
                .collect(),
        }
    }
    fn commit(&mut self, next: Registry) -> Result<()> {
        let encoded = serde_json::to_string(&next).map_err(|_| "internalError")?;
        self.vault.write(&encoded)?;
        self.registry = next;
        Ok(())
    }
    pub fn authorize(
        &mut self,
        version: u64,
        token: Option<&str>,
        code: Option<&str>,
        name: &str,
        now: u64,
    ) -> Result<Authorization> {
        if version != 1 {
            return Err("protocolVersion".into());
        }
        if let Some(token) = token {
            return self
                .device_for_token(token, false)
                .map(|id| Authorization {
                    device_id: id,
                    issued_token: None,
                })
                .ok_or_else(|| "token".into());
        }
        let Some(attempt) = code else {
            return Err("token".into());
        };
        let Some(current) = self.code.as_mut().filter(|c| now < c.expires_at) else {
            return Err("code".into());
        };
        let matched: bool = digest(&current.text).ct_eq(&digest(attempt)).into();
        if !matched {
            current.attempts += 1;
            if current.attempts >= 5 {
                let allowed = current.diagnostics;
                self.issue_code(allowed, now)?;
            }
            return Err("code".into());
        }
        let allowed = current.diagnostics;
        let token: String = rand::random::<[u8; 32]>()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let device_id = Uuid::new_v4().to_string();
        let mut next = self.registry.clone();
        if next.devices.len() >= MAX_DEVICES {
            return Err("pairingCapacity".into());
        }
        next.devices.push(Device {
            id: device_id.clone(),
            name: display_name(name),
            digest: digest(&token),
            diagnostics: allowed,
        });
        self.commit(next)?; // A failed credential write never admits the device or consumes its code.
        self.code = None;
        Ok(Authorization {
            device_id,
            issued_token: Some(token),
        })
    }
    pub fn device_for_token(&self, token: &str, diagnostics: bool) -> Option<String> {
        let candidate = digest(token);
        let mut matched = None;
        for device in &self.registry.devices {
            let equal: bool = device.digest.ct_eq(&candidate).into();
            if equal && (!diagnostics || device.diagnostics) {
                matched = Some(device.id.clone());
            }
        }
        matched
    }
    pub fn is_authorized(&self, device_id: &str, diagnostics: bool) -> bool {
        self.registry
            .devices
            .iter()
            .any(|d| d.id == device_id && (!diagnostics || d.diagnostics))
    }
    pub fn revoke(&mut self, device_id: &str) -> Result<()> {
        let mut next = self.registry.clone();
        next.devices.retain(|d| d.id != device_id);
        self.commit(next)
    }
    pub fn set_diagnostics(&mut self, device_id: &str, enabled: bool) -> Result<()> {
        let mut next = self.registry.clone();
        next.devices
            .iter_mut()
            .find(|d| d.id == device_id)
            .ok_or("deviceNotFound")?
            .diagnostics = enabled;
        self.commit(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    };
    #[derive(Default)]
    struct Vault {
        value: Mutex<Option<String>>,
        fail: AtomicBool,
    }
    impl SecretVault for Vault {
        fn read(&self) -> Result<Option<String>> {
            Ok(self.value.lock().unwrap().clone())
        }
        fn write(&self, value: &str) -> Result<()> {
            if self.fail.load(Ordering::Relaxed) {
                return Err("credentialsUnavailable".into());
            }
            *self.value.lock().unwrap() = Some(value.into());
            Ok(())
        }
    }
    #[test]
    fn pairing_persists_identity_and_hashes_then_revokes() {
        let vault = Arc::new(Vault::default());
        let mut pairing = Pairing::load(vault.clone()).unwrap();
        let server = pairing.server_id().to_owned();
        pairing.issue_code(true, 100).unwrap();
        let code = pairing.info(100).code.unwrap();
        let auth = pairing
            .authorize(1, None, Some(&code), "合成 App", 100)
            .unwrap();
        let token = auth.issued_token.unwrap();
        assert!(
            !vault
                .value
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .contains(&token)
        );
        assert!(pairing.info(100).code.is_none());
        assert!(pairing.authorize(1, None, Some(&code), "App", 100).is_err());
        let mut restored = Pairing::load(vault).unwrap();
        assert_eq!(restored.server_id(), server);
        assert!(restored.device_for_token(&token, true).is_some());
        restored.set_diagnostics(&auth.device_id, false).unwrap();
        assert!(restored.device_for_token(&token, false).is_some());
        assert!(restored.device_for_token(&token, true).is_none());
        restored.revoke(&auth.device_id).unwrap();
        assert!(restored.device_for_token(&token, false).is_none());
    }
    #[test]
    fn expiry_attempt_limit_and_version_precedence() {
        let mut pairing = Pairing::load(Arc::new(Vault::default())).unwrap();
        pairing.issue_code(false, 100).unwrap();
        let code = pairing.info(100).code.unwrap();
        assert_eq!(
            pairing
                .authorize(2, None, Some("wrong"), "App", 100)
                .err()
                .unwrap(),
            "protocolVersion"
        );
        for _ in 0..5 {
            assert!(
                pairing
                    .authorize(1, None, Some("wrong"), "App", 100)
                    .is_err()
            );
        }
        assert!(pairing.info(100).code.is_some()); // A fresh one-time window is created.
        assert!(
            pairing
                .authorize(1, None, Some(&code), "App", 1000)
                .is_err()
        );
        assert!(pairing.info(1000).code.is_none());
    }
    #[test]
    fn failed_persistence_does_not_admit_or_consume_code() {
        let vault = Arc::new(Vault::default());
        let mut pairing = Pairing::load(vault.clone()).unwrap();
        pairing.issue_code(true, 100).unwrap();
        let code = pairing.info(100).code.unwrap();
        vault.fail.store(true, Ordering::Relaxed);
        assert!(pairing.authorize(1, None, Some(&code), "App", 100).is_err());
        assert_eq!(pairing.info(100).devices.len(), 0);
        assert!(pairing.info(100).code.is_some());
        vault.fail.store(false, Ordering::Relaxed);
        assert!(pairing.authorize(1, None, Some(&code), "App", 100).is_ok());
    }
}
