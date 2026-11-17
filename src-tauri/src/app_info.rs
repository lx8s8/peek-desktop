use crate::protocol::session::Result;
use serde::Serialize;

pub const PROJECT: &str = "https://github.com/lx8s8/peek-desktop";
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: &'static str,
    platform: &'static str,
    architecture: &'static str,
}
pub fn info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
    }
}
pub fn legal_text(document: &str) -> Result<&'static str> {
    match document {
        "license" => Ok(include_str!("../../LICENSE")),
        "notices" => Ok(include_str!("../../THIRD_PARTY_NOTICES.md")),
        _ => Err("invalidLegalDocument".into()),
    }
}
pub fn project_link(link: &str) -> Result<&'static str> {
    match link {
        "project" => Ok(PROJECT),
        "issues" => Ok("https://github.com/lx8s8/peek-desktop/issues"),
        "releases" => Ok("https://github.com/lx8s8/peek-desktop/releases"),
        "sdk" => Ok("https://github.com/lx8s8/peek-flutter-sdk"),
        "upstream" => Ok("https://github.com/artdima/peek-pro"),
        _ => Err("invalidProjectLink".into()),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legal_text_and_links_are_fixed_project_resources() {
        assert!(legal_text("license").unwrap().starts_with("MIT License"));
        assert!(legal_text("notices").unwrap().contains("MIT"));
        assert!(legal_text("../../credentials").is_err());
        for link in ["project", "issues", "releases", "sdk", "upstream"] {
            assert!(
                project_link(link)
                    .unwrap()
                    .starts_with("https://github.com/")
            );
        }
        for link in [
            "file:///tmp/data",
            "https://example.test",
            "javascript:alert(1)",
        ] {
            assert!(project_link(link).is_err());
        }
    }
}
