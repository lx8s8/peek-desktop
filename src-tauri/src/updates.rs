use crate::{app_info::PROJECT, protocol::session::Result};
use reqwest::{Client, StatusCode};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const ENDPOINT: &str = "https://api.github.com/repos/lx8s8/peek-desktop/releases/latest";
const MAX_RESPONSE: usize = 512 * 1024;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub status: &'static str,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub release_url: Option<String>,
    pub download_url: Option<String>,
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
pub struct Checker {
    cache: Mutex<Option<(Instant, UpdateInfo)>>,
}
impl Checker {
    pub async fn check(&self) -> Result<UpdateInfo> {
        let mut cache = self.cache.lock().await;
        if let Some((time, info)) = cache.as_ref()
            && time.elapsed() < Duration::from_secs(60)
        {
            return Ok(info.clone());
        }
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
                current_version: env!("CARGO_PKG_VERSION").into(),
                latest_version: None,
                release_url: None,
                download_url: None,
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
        let info = parse_release(
            &bytes,
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH,
        )?;
        *cache = Some((Instant::now(), info.clone()));
        Ok(info)
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
fn parse_release(bytes: &[u8], current: &str, os: &str, arch: &str) -> Result<UpdateInfo> {
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
    let mut notes = release.body.unwrap_or_default();
    let mut end = notes.len().min(16 * 1024);
    while !notes.is_char_boundary(end) {
        end -= 1;
    }
    notes.truncate(end);
    Ok(UpdateInfo {
        status: match latest.cmp_precedence(&current_version) {
            std::cmp::Ordering::Greater => "available",
            std::cmp::Ordering::Equal => "current",
            std::cmp::Ordering::Less => "ahead",
        },
        current_version: current.into(),
        latest_version: Some(latest.to_string()),
        release_url: Some(release.html_url),
        download_url,
        notes,
    })
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
    fn release(tag: &str) -> serde_json::Value {
        json!({"tag_name":tag,"draft":false,"prerelease":false,"html_url":format!("{PROJECT}/releases/tag/{tag}"),"body":"更新说明 <script>inert</script>","assets":[{"name":"Peek-Desktop_0.2.0_macos-arm64-unsigned.dmg","state":"uploaded","browser_download_url":format!("{PROJECT}/releases/download/{tag}/Peek-Desktop_0.2.0_macos-arm64-unsigned.dmg")}]})
    }
    #[test]
    fn stable_versions_compare_semantically_and_choose_exact_platform_assets() {
        let bytes = serde_json::to_vec(&release("v0.2.0")).unwrap();
        for (current, state) in [
            ("0.1.9", "available"),
            ("0.2.0", "current"),
            ("0.10.0", "ahead"),
        ] {
            let info = parse_release(&bytes, current, "macos", "aarch64").unwrap();
            assert_eq!(info.status, state);
            assert!(info.download_url.is_some());
            assert!(info.notes.contains("<script>"));
        }
        assert!(
            parse_release(&bytes, "0.1.0", "windows", "x86_64")
                .unwrap()
                .download_url
                .is_none()
        );
        assert!(valid_release_link(&format!(
            "{PROJECT}/releases/download/v0.2.0/Peek-Desktop_0.2.0_macos-arm64-unsigned.dmg"
        )));
    }
    #[test]
    fn prereleases_bad_metadata_and_external_or_mismatched_downloads_are_rejected() {
        for tag in ["v0.2.0-rc.1", "garbage", "v0.2.0/extra"] {
            assert!(
                parse_release(
                    &serde_json::to_vec(&release(tag)).unwrap(),
                    "0.1.0",
                    "macos",
                    "aarch64"
                )
                .is_err()
            );
        }
        for field in ["draft", "prerelease"] {
            let mut r = release("v0.2.0");
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
        let mut r = release("v0.2.0");
        r["assets"][0]["browser_download_url"] = json!("https://evil.test/setup.dmg");
        assert!(
            parse_release(
                &serde_json::to_vec(&r).unwrap(),
                "0.1.0",
                "macos",
                "aarch64"
            )
            .unwrap()
            .download_url
            .is_none()
        );
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
}
