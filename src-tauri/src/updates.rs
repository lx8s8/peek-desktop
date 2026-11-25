//! 应用内更新通过 GitHub Releases 获取版本与签名更新清单，并由内置公钥完成完整性校验。
use crate::{app_info::PROJECT, protocol::session::Result};
use reqwest::{Client, StatusCode};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::{
    sync::Mutex as StdMutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, ipc::Channel};
use tokio::sync::Mutex as AsyncMutex;

const ENDPOINT: &str = "https://api.github.com/repos/lx8s8/peek-desktop/releases/latest";
const MAX_RESPONSE: usize = 512 * 1024;
const CHECK_CACHE_TTL: Duration = Duration::from_secs(60);
const PENDING_UPDATE_TTL: Duration = Duration::from_secs(900);

/// 更新下载与安装阶段的实时进度事件。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub phase: &'static str,
    pub downloaded: u64,
    pub total: Option<u64>,
}

/// 返回给前端的版本检查结果。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub status: &'static str,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub release_url: Option<String>,
    pub download_url: Option<String>,
    pub can_install: bool,
    pub notes: String,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    html_url: String,
    body: Option<String>,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    state: String,
}

#[derive(Default)]
enum Operation {
    #[default]
    Idle,
    Downloading(Option<tokio::sync::oneshot::Sender<()>>),
    Installing,
}

/// 统一管理更新检查缓存、待安装更新对象与下载取消/安装状态机。
#[derive(Default)]
pub struct Checker {
    cache: AsyncMutex<Option<(Instant, UpdateInfo)>>,
    pending: StdMutex<Option<(Instant, tauri_plugin_updater::Update)>>,
    operation: StdMutex<Operation>,
}

struct OperationGuard<'a>(&'a Checker);

impl Drop for OperationGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.operation.lock() {
            *state = Operation::Idle;
        }
    }
}

impl Checker {
    fn busy(&self) -> Result<bool> {
        Ok(!matches!(
            *self.operation.lock().map_err(|_| "updateUnavailable")?,
            Operation::Idle
        ))
    }

    fn start(&self) -> Result<tokio::sync::oneshot::Receiver<()>> {
        let mut state = self.operation.lock().map_err(|_| "updateUnavailable")?;
        if !matches!(*state, Operation::Idle) {
            return Err("updateBusy".into());
        }
        let (send, receive) = tokio::sync::oneshot::channel();
        *state = Operation::Downloading(Some(send));
        Ok(receive)
    }

    /// 取消正在进行的更新下载；已进入安装阶段或空闲时返回 `false`。
    pub fn cancel(&self) -> Result<bool> {
        let mut state = self.operation.lock().map_err(|_| "updateUnavailable")?;
        if let Operation::Downloading(sender) = &mut *state {
            if let Some(sender) = sender.take() {
                let _ = sender.send(());
            }
            return Ok(true);
        }
        Ok(false)
    }

    fn begin_install(&self) -> Result<()> {
        let mut state = self.operation.lock().map_err(|_| "updateUnavailable")?;
        // 通过同一把互斥锁将取消动作与进入安装阶段严格串行化。
        if !matches!(*state, Operation::Downloading(Some(_))) {
            return Err("updateCancelled".into());
        }
        *state = Operation::Installing;
        Ok(())
    }

    /// 检查最新版本；当正式发布附带受信任的 `latest.json` 时同时初始化应用内更新对象。
    pub async fn check(&self, app: &AppHandle) -> Result<UpdateInfo> {
        if self.busy()? {
            return Err("updateBusy".into());
        }
        let mut cache = self.cache.lock().await;
        if let Some((time, info)) = cache.as_ref()
            && time.elapsed() < CHECK_CACHE_TTL
        {
            let pending_ready = !info.can_install
                || self
                    .pending
                    .lock()
                    .map_err(|_| "updateUnavailable")?
                    .as_ref()
                    .is_some_and(|(checked, _)| checked.elapsed() < PENDING_UPDATE_TTL);
            if pending_ready {
                return Ok(info.clone());
            }
        }
        self.pending.lock().map_err(|_| "updateUnavailable")?.take();

        let current_version = app.package_info().version.to_string();
        let client = Client::builder()
            .user_agent(concat!("Peek-Desktop/", env!("CARGO_PKG_VERSION")))
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(6))
            .timeout(Duration::from_secs(12))
            .build()
            .map_err(|_| "updateCheckFailed")?;
        let mut response = client
            .get(ENDPOINT)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|_| "updateCheckFailed")?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(UpdateInfo {
                status: "notPublished",
                current_version,
                latest_version: None,
                release_url: None,
                download_url: None,
                can_install: false,
                notes: String::new(),
            });
        }
        if matches!(
            response.status(),
            StatusCode::FORBIDDEN | StatusCode::TOO_MANY_REQUESTS
        ) {
            return Err("updateRateLimited".into());
        }
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|n| n > MAX_RESPONSE as u64)
        {
            return Err("updateCheckFailed".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "updateCheckFailed")? {
            if bytes.len() + chunk.len() > MAX_RESPONSE {
                return Err("updateInvalidRelease".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let (mut info, has_manifest) = parse_release(
            &bytes,
            &current_version,
            std::env::consts::OS,
            std::env::consts::ARCH,
        )?;

        if info.status == "available" && has_manifest {
            use tauri_plugin_updater::UpdaterExt;
            let updater = app
                .updater_builder()
                .timeout(Duration::from_secs(60))
                .build()
                .map_err(|_| "updateCheckFailed")?;
            if let Some(update) = updater.check().await.map_err(|_| "updateManifestFailed")? {
                let expected = info.latest_version.as_deref().unwrap_or_default();
                if update.version != expected
                    || !trusted_asset(update.download_url.as_str(), &update.version)
                {
                    return Err("updateManifestMismatch".into());
                }
                *self.pending.lock().map_err(|_| "updateUnavailable")? =
                    Some((Instant::now(), update));
                info.can_install = true;
            }
        }

        *cache = Some((Instant::now(), info.clone()));
        Ok(info)
    }

    /// 下载已验证签名的更新包、落盘当前工作区后覆盖安装并自动重启应用。
    pub async fn install(&self, app: &AppHandle, progress: Channel<UpdateProgress>) -> Result<()> {
        let mut cancel = self.start()?;
        let _reset = OperationGuard(self);

        let (checked, update) = self
            .pending
            .lock()
            .map_err(|_| "updateUnavailable")?
            .take()
            .ok_or("updateNotChecked")?;
        // 消费待安装更新后清空短缓存，确保取消或失败后重试会重新拉取有效更新对象。
        self.cache.lock().await.take();
        if checked.elapsed() > PENDING_UPDATE_TTL {
            return Err("updateExpired".into());
        }

        let mut downloaded = 0u64;
        let mut last = Instant::now();
        let _ = progress.send(UpdateProgress {
            phase: "download",
            downloaded,
            total: None,
        });
        // 官方 updater 插件会在返回字节前验证内置公钥签名与绑定的版本号。
        let download = update.download(
            |size, total| {
                downloaded = downloaded.saturating_add(size as u64);
                if last.elapsed() >= Duration::from_millis(100) {
                    let _ = progress.send(UpdateProgress {
                        phase: "download",
                        downloaded,
                        total,
                    });
                    last = Instant::now();
                }
            },
            || {},
        );
        let bytes = tokio::select! {
            biased;
            _ = &mut cancel => return Err("updateCancelled".into()),
            result = download => result.map_err(|_| "updateDownloadFailed")?,
        };

        self.begin_install()?;
        let total = bytes.len() as u64;
        let _ = progress.send(UpdateProgress {
            phase: "install",
            downloaded: total,
            total: Some(total),
        });

        crate::commands::prepare_for_update_restart(app).await;
        let installed = tauri::async_runtime::spawn_blocking(move || update.install(bytes))
            .await
            .map_err(|_| "updateInstallFailed")?;
        if installed.is_err() {
            crate::commands::revert_update_restart(app);
            return Err("updateInstallFailed".into());
        }

        app.restart();
    }
}

fn stable_tag(tag: &str) -> Option<Version> {
    if tag.len() > 80 {
        return None;
    }
    let version = Version::parse(tag.strip_prefix('v').unwrap_or(tag)).ok()?;
    version.pre.is_empty().then_some(version)
}

fn asset_names(version: &Version, os: &str, arch: &str) -> Vec<String> {
    let target = match (os, arch) {
        ("macos", "aarch64") => "macos-arm64-unsigned.dmg",
        ("macos", "x86_64") => "macos-x64-unsigned.dmg",
        ("windows", "x86_64") => "windows-x64-unsigned.exe",
        _ => return Vec::new(),
    };
    vec![format!("Peek-Desktop_{version}_{target}")]
}

/// 校验更新清单与安装包下载地址必须来自官方仓库对应版本的 HTTPS 附件路径。
fn trusted_asset(value: &str, version: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url
            .path()
            .strip_prefix(&format!(
                "/lx8s8/peek-desktop/releases/download/v{version}/"
            ))
            .is_some_and(|name| {
                !name.is_empty()
                    && !name.contains('/')
                    && !name.contains('%')
                    && !name.contains("..")
            })
}

fn parse_release(bytes: &[u8], current: &str, os: &str, arch: &str) -> Result<(UpdateInfo, bool)> {
    let release: Release = serde_json::from_slice(bytes).map_err(|_| "updateInvalidRelease")?;
    let latest = stable_tag(&release.tag_name).ok_or("updateInvalidRelease")?;
    let current_version = Version::parse(current).map_err(|_| "updateInvalidRelease")?;
    if release.draft
        || release.prerelease
        || release.assets.len() > 100
        || release.html_url != format!("{PROJECT}/releases/tag/{}", release.tag_name)
    {
        return Err("updateInvalidRelease".into());
    }
    let names = asset_names(&latest, os, arch);
    let download_url = release
        .assets
        .iter()
        .find(|asset| {
            asset.state == "uploaded"
                && names.contains(&asset.name)
                && asset.browser_download_url
                    == format!(
                        "{PROJECT}/releases/download/{}/{}",
                        release.tag_name, asset.name
                    )
        })
        .map(|asset| asset.browser_download_url.clone());
    let latest_str = latest.to_string();
    let has_manifest = release.assets.iter().any(|asset| {
        asset.state == "uploaded"
            && asset.name == "latest.json"
            && trusted_asset(&asset.browser_download_url, &latest_str)
    });
    let mut notes = release.body.unwrap_or_default();
    let mut end = notes.len().min(16 * 1024);
    while !notes.is_char_boundary(end) {
        end -= 1;
    }
    notes.truncate(end);
    Ok((
        UpdateInfo {
            status: match latest.cmp_precedence(&current_version) {
                std::cmp::Ordering::Greater => "available",
                std::cmp::Ordering::Equal => "current",
                std::cmp::Ordering::Less => "ahead",
            },
            current_version: current.into(),
            latest_version: Some(latest_str),
            release_url: Some(release.html_url),
            download_url,
            can_install: false,
            notes,
        },
        has_manifest,
    ))
}

pub fn valid_release_link(value: &str) -> bool {
    if let Some(tag) = value.strip_prefix(&format!("{PROJECT}/releases/tag/")) {
        return stable_tag(tag).is_some();
    }
    let Some(rest) = value.strip_prefix(&format!("{PROJECT}/releases/download/")) else {
        return false;
    };
    let Some((tag, name)) = rest.split_once('/') else {
        return false;
    };
    let Some(version) = stable_tag(tag) else {
        return false;
    };
    [
        ("macos", "aarch64"),
        ("macos", "x86_64"),
        ("windows", "x86_64"),
    ]
    .iter()
    .any(|(os, arch)| asset_names(&version, os, arch).iter().any(|n| n == name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn release(tag: &str, with_manifest: bool) -> serde_json::Value {
        let mut assets = vec![json!({
            "name": "Peek-Desktop_0.2.0_macos-arm64-unsigned.dmg",
            "state": "uploaded",
            "browser_download_url": format!("{PROJECT}/releases/download/{tag}/Peek-Desktop_0.2.0_macos-arm64-unsigned.dmg")
        })];
        if with_manifest {
            assets.push(json!({
                "name": "latest.json",
                "state": "uploaded",
                "browser_download_url": format!("{PROJECT}/releases/download/{tag}/latest.json")
            }));
        }
        json!({
            "tag_name": tag,
            "draft": false,
            "prerelease": false,
            "html_url": format!("{PROJECT}/releases/tag/{tag}"),
            "body": "更新说明 <script>inert</script>",
            "assets": assets
        })
    }

    #[test]
    fn stable_versions_compare_semantically_and_choose_exact_platform_assets() {
        let bytes = serde_json::to_vec(&release("v0.2.0", true)).unwrap();
        for (current, state) in [
            ("0.1.9", "available"),
            ("0.2.0", "current"),
            ("0.10.0", "ahead"),
        ] {
            let (info, has_manifest) = parse_release(&bytes, current, "macos", "aarch64").unwrap();
            assert_eq!(info.status, state);
            assert!(info.download_url.is_some());
            assert!(has_manifest);
            assert!(!info.can_install);
            assert!(info.notes.contains("<script>"));
        }
        let (win_info, win_manifest) = parse_release(&bytes, "0.1.0", "windows", "x86_64").unwrap();
        assert!(win_info.download_url.is_none());
        assert!(win_manifest);
        assert!(valid_release_link(&format!(
            "{PROJECT}/releases/download/v0.2.0/Peek-Desktop_0.2.0_macos-arm64-unsigned.dmg"
        )));
    }

    #[test]
    fn prereleases_bad_metadata_and_external_or_mismatched_downloads_are_rejected() {
        for tag in ["v0.2.0-rc.1", "garbage", "v0.2.0/extra"] {
            assert!(
                parse_release(
                    &serde_json::to_vec(&release(tag, false)).unwrap(),
                    "0.1.0",
                    "macos",
                    "aarch64"
                )
                .is_err()
            );
        }
        for field in ["draft", "prerelease"] {
            let mut r = release("v0.2.0", false);
            r[field] = json!(true);
            assert!(
                parse_release(
                    &serde_json::to_vec(&r).unwrap(),
                    "0.1.0",
                    "macos",
                    "aarch64"
                )
                .is_err()
            );
        }
        let mut r = release("v0.2.0", true);
        r["assets"][0]["browser_download_url"] = json!("https://evil.test/setup.dmg");
        r["assets"][1]["browser_download_url"] = json!("https://evil.test/latest.json");
        let (info, has_manifest) = parse_release(
            &serde_json::to_vec(&r).unwrap(),
            "0.1.0",
            "macos",
            "aarch64",
        )
        .unwrap();
        assert!(info.download_url.is_none());
        assert!(!has_manifest);
        for url in [
            "file:///tmp/test",
            "javascript:alert(1)",
            "https://github.com/evil/peek-desktop/releases/tag/v0.2.0",
            "https://github.com/lx8s8/peek-desktop/releases/tag/v0.2.0?extra",
            "https://github.com/lx8s8/peek-desktop/releases/download/v0.2.0/../setup.exe",
        ] {
            assert!(!valid_release_link(url));
        }
    }

    #[test]
    fn trusted_asset_accepts_only_matching_official_release_files() {
        assert!(trusted_asset(
            "https://github.com/lx8s8/peek-desktop/releases/download/v0.5.0/Peek-Desktop_0.5.0_macos-arm64-unsigned.app.tar.gz",
            "0.5.0"
        ));
        for value in [
            "http://github.com/lx8s8/peek-desktop/releases/download/v0.5.0/app.tar.gz",
            "https://github.com/other/peek-desktop/releases/download/v0.5.0/app.tar.gz",
            "https://github.com/lx8s8/peek-desktop/releases/download/v0.4.0/app.tar.gz",
            "https://github.com/lx8s8/peek-desktop/releases/download/v0.5.0/app.tar.gz?token=test",
            "https://github.com/lx8s8/peek-desktop/releases/download/v0.5.0/a/b",
            "https://github.com/lx8s8/peek-desktop/releases/download/v0.5.0/..%2Fevil",
            "https://github.com/lx8s8/peek-desktop/releases/download/v0.5.0/..evil",
        ] {
            assert!(!trusted_asset(value, "0.5.0"));
        }
    }

    #[tokio::test]
    async fn cancellation_serializes_with_installation_and_guard_resets_state() {
        let control = Checker::default();
        let mut receive = control.start().unwrap();
        let guard = OperationGuard(&control);
        assert!(control.busy().unwrap());
        assert_eq!(control.start().unwrap_err(), "updateBusy");
        assert!(control.cancel().unwrap());
        assert_eq!(receive.try_recv(), Ok(()));
        assert_eq!(control.begin_install().unwrap_err(), "updateCancelled");
        drop(guard);
        assert!(!control.busy().unwrap());

        let _receive = control.start().unwrap();
        let guard = OperationGuard(&control);
        control.begin_install().unwrap();
        assert!(!control.cancel().unwrap());
        assert_eq!(control.start().unwrap_err(), "updateBusy");
        drop(guard);
        assert!(!control.busy().unwrap());
    }
}
