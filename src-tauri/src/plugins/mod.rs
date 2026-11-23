//! 开源、脱敏的堆栈符号化插件引擎。
//!
//! 支持三类标准 Provider：
//! - `local`：本地 `.symbols` 目录扫描（按 ELF Build ID / Mach-O UUID 精确匹配）并调用本机 `flutter symbolize`
//! - `http`：标准 HTTP JSON 符号化服务（适合团队内网共享，免 SSH 密钥与符号表落盘）
//! - `cli`：本地外部 CLI 插件（stdin/stdout 标准 JSON 契约，可对接任意私有构建或符号服务）

pub mod elf;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};

/// 插件清单元协议版本。
pub const PLUGIN_SCHEMA_VERSION: u32 = 1;
const MAX_MANIFEST_BYTES: usize = 256 * 1024;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_CACHE_ENTRIES: usize = 128;
const DEFAULT_TIMEOUT_MS: u64 = 20_000;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 120_000;

/// 堆栈还原插件类型。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginKind {
    Local,
    Http,
    Cli,
}

/// 本地 `.symbols` 目录还原配置。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPluginConfig {
    pub symbols_dir: String,
    #[serde(default)]
    pub flutter_bin: Option<String>,
}

/// 远端 HTTP 符号化服务配置。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpPluginConfig {
    pub endpoint: String,
    #[serde(default)]
    pub health_endpoint: Option<String>,
    /// 自定义鉴权头名，留空时默认使用 `Authorization: Bearer <token>`。
    #[serde(default)]
    pub auth_header: Option<String>,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
}

/// 本地外部 CLI 插件配置（标准 stdin/stdout JSON 协议）。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliPluginConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub working_dir: Option<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

/// 堆栈还原插件完整定义（也是 `.peekplugin.json` 导入/导出的标准格式）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolicatorPlugin {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    pub kind: PluginKind,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default)]
    pub local: Option<LocalPluginConfig>,
    #[serde(default)]
    pub http: Option<HttpPluginConfig>,
    #[serde(default)]
    pub cli: Option<CliPluginConfig>,
}

fn default_schema_version() -> u32 {
    PLUGIN_SCHEMA_VERSION
}

fn default_enabled() -> bool {
    true
}

fn default_timeout_ms() -> u64 {
    DEFAULT_TIMEOUT_MS
}

/// 返回给前端的插件视图（隐藏明文密钥，只暴露掩码与编辑所需的非敏感配置）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginView {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub enabled: bool,
    pub kind: PluginKind,
    pub timeout_ms: u64,
    pub source: String,
    pub is_default: bool,
    pub has_secret: bool,
    pub masked_token: Option<String>,
    pub local: Option<LocalPluginConfig>,
    pub http: Option<HttpPluginView>,
    pub cli: Option<CliPluginConfig>,
}

/// HTTP 配置脱敏视图。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpPluginView {
    pub endpoint: String,
    pub health_endpoint: Option<String>,
    pub auth_header: Option<String>,
    pub has_token: bool,
    pub masked_token: Option<String>,
    pub headers: BTreeMap<String, String>,
}

/// 插件列表快照。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginListSnapshot {
    pub default_plugin_id: Option<String>,
    pub discovery_dir: Option<String>,
    pub plugins: Vec<PluginView>,
}

/// 堆栈还原请求参数。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolicateRequest {
    #[serde(default)]
    pub plugin_id: Option<String>,
    pub stack_trace: String,
    #[serde(default)]
    pub stack_format: Option<String>,
    #[serde(default)]
    pub build_id: Option<String>,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub arch: Option<String>,
    #[serde(default)]
    pub app_version: Option<String>,
    #[serde(default)]
    pub build_number: Option<String>,
    #[serde(default)]
    pub flavor: Option<String>,
    #[serde(default)]
    pub brand: Option<String>,
    #[serde(default)]
    pub job_id: Option<String>,
    #[serde(default)]
    pub attributes: Option<Value>,
    #[serde(default)]
    pub force_refresh: bool,
}

/// 命中的构建信息摘要（通用、无厂商耦合字段）。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchedBuildInfo {
    #[serde(default)]
    pub job_id: Option<String>,
    #[serde(default)]
    pub app_version: Option<String>,
    #[serde(default)]
    pub flavor: Option<String>,
    #[serde(default)]
    pub brand: Option<String>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub source_sha: Option<String>,
    #[serde(default)]
    pub source_branch: Option<String>,
    #[serde(default)]
    pub matched_by: Option<String>,
    #[serde(default)]
    pub symbol_file: Option<String>,
}

/// 堆栈还原结果。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolicateResponse {
    pub ok: bool,
    pub symbolized_stack: Option<String>,
    pub provider_id: String,
    pub provider_name: String,
    pub cached: bool,
    pub duration_ms: u64,
    pub detected: elf::AotStackInfo,
    pub matched_build: Option<MatchedBuildInfo>,
    pub warnings: Vec<String>,
    pub error: Option<String>,
}

/// 服务端已索引构建的脱敏摘要项。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceBuildSummary {
    #[serde(default)]
    pub job_id: Option<String>,
    #[serde(default)]
    pub app_version: Option<String>,
    #[serde(default)]
    pub flavor: Option<String>,
    #[serde(default)]
    pub brand: Option<String>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub finished_at: Option<String>,
}

/// 通过单地址拉取清单时服务端一并返回的连通与索引摘要。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDiscoveryInfo {
    #[serde(default)]
    pub available_builds: Option<u64>,
    #[serde(default)]
    pub symbol_count: Option<u64>,
    #[serde(default)]
    pub recent_builds: Vec<ServiceBuildSummary>,
    #[serde(default)]
    pub message: Option<String>,
}

/// 插件连接测试结果。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTestResult {
    pub ok: bool,
    pub message: String,
    pub latency_ms: u64,
    pub available_builds: Option<u64>,
    pub details: Option<String>,
    pub recent_builds: Vec<ServiceBuildSummary>,
}

/// 解析后的插件安装包预览（供安装确认弹窗展示，用户点击确认前不会落盘或执行）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedPluginPreview {
    pub plugin: SymbolicatorPlugin,
    pub has_secret: bool,
    pub masked_token: Option<String>,
    pub requires_trust_warning: bool,
    pub service_info: Option<ServiceDiscoveryInfo>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredPluginRegistry {
    #[serde(default = "default_schema_version")]
    schema_version: u32,
    #[serde(default)]
    default_plugin_id: Option<String>,
    #[serde(default)]
    plugins: Vec<SymbolicatorPlugin>,
}

/// 插件管理器与还原结果 LRU 缓存。
#[derive(Default)]
pub struct PluginManager {
    config_file: Option<PathBuf>,
    discovery_dir: Option<PathBuf>,
    registry: StoredPluginRegistry,
    cache: HashMap<String, SymbolicateResponse>,
    cache_order: VecDeque<String>,
}

impl PluginManager {
    /// 初始化插件配置路径并加载已托管插件。
    pub fn initialize(&mut self, app_config_dir: PathBuf) {
        let managed_dir = app_config_dir.join("plugins");
        let config_file = managed_dir.join("config.json");
        self.config_file = Some(config_file.clone());
        self.discovery_dir = default_discovery_dir();

        if let Ok(raw) = fs::read_to_string(&config_file)
            && let Ok(parsed) = serde_json::from_str::<StoredPluginRegistry>(&raw)
        {
            self.registry = parsed;
        }
    }

    /// 供测试注入自定义目录。
    #[cfg(test)]
    pub fn initialize_for_test(&mut self, config_file: PathBuf, discovery_dir: Option<PathBuf>) {
        self.config_file = Some(config_file);
        self.discovery_dir = discovery_dir;
    }

    /// 列出全部可用插件（托管配置优先于同 ID 的外部发现清单）。
    pub fn list(&self) -> PluginListSnapshot {
        let mut combined: Vec<(SymbolicatorPlugin, String)> = self
            .registry
            .plugins
            .iter()
            .cloned()
            .map(|p| (p, "managed".to_string()))
            .collect();

        for discovered in self.load_discovered_plugins() {
            if !combined
                .iter()
                .any(|(existing, _)| existing.id == discovered.id)
            {
                combined.push((discovered, "discovered".to_string()));
            }
        }

        let effective_default = self.effective_default_id(&combined);
        let plugins = combined
            .into_iter()
            .map(|(plugin, source)| {
                let is_default = effective_default.as_deref() == Some(plugin.id.as_str());
                to_plugin_view(&plugin, source, is_default)
            })
            .collect();

        PluginListSnapshot {
            default_plugin_id: effective_default,
            discovery_dir: self
                .discovery_dir
                .as_ref()
                .map(|p| p.to_string_lossy().to_string()),
            plugins,
        }
    }

    /// 保存或更新托管插件；编辑时若 HTTP token 为空且原插件已有 token，可选择保留原密钥。
    pub fn upsert(
        &mut self,
        mut plugin: SymbolicatorPlugin,
        keep_existing_secret: bool,
        set_as_default: bool,
    ) -> Result<PluginListSnapshot, String> {
        if keep_existing_secret
            && plugin.kind == PluginKind::Http
            && let Some(existing) = self.find_plugin(&plugin.id)
            && let (Some(new_http), Some(old_http)) = (plugin.http.as_mut(), existing.http.as_ref())
            && new_http
                .token
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
        {
            new_http.token = old_http.token.clone();
        }
        validate_plugin(&mut plugin)?;

        if let Some(slot) = self
            .registry
            .plugins
            .iter_mut()
            .find(|item| item.id == plugin.id)
        {
            *slot = plugin.clone();
        } else {
            self.registry.plugins.push(plugin.clone());
        }

        if set_as_default || self.registry.default_plugin_id.is_none() {
            self.registry.default_plugin_id = Some(plugin.id.clone());
        }
        self.clear_cache();
        self.persist()?;
        Ok(self.list())
    }

    /// 删除指定托管插件。
    pub fn remove(&mut self, plugin_id: &str) -> Result<PluginListSnapshot, String> {
        let before = self.registry.plugins.len();
        self.registry.plugins.retain(|item| item.id != plugin_id);
        if self.registry.plugins.len() == before {
            return Err(
                "未找到可删除的已安装插件（外部目录自动发现的清单请直接在目录中移除）".into(),
            );
        }
        if self.registry.default_plugin_id.as_deref() == Some(plugin_id) {
            self.registry.default_plugin_id =
                self.registry.plugins.first().map(|item| item.id.clone());
        }
        self.clear_cache();
        self.persist()?;
        Ok(self.list())
    }

    /// 切换插件启用/禁用状态。
    pub fn set_enabled(
        &mut self,
        plugin_id: &str,
        enabled: bool,
    ) -> Result<PluginListSnapshot, String> {
        if let Some(slot) = self
            .registry
            .plugins
            .iter_mut()
            .find(|item| item.id == plugin_id)
        {
            slot.enabled = enabled;
        } else if let Some(mut discovered) = self
            .load_discovered_plugins()
            .into_iter()
            .find(|item| item.id == plugin_id)
        {
            discovered.enabled = enabled;
            self.registry.plugins.push(discovered);
        } else {
            return Err("未找到指定插件".into());
        }
        self.clear_cache();
        self.persist()?;
        Ok(self.list())
    }

    /// 设置默认堆栈还原插件。
    pub fn set_default(&mut self, plugin_id: &str) -> Result<PluginListSnapshot, String> {
        if self.find_plugin(plugin_id).is_none() {
            return Err("未找到指定插件".into());
        }
        self.registry.default_plugin_id = Some(plugin_id.to_string());
        self.persist()?;
        Ok(self.list())
    }

    /// 查找指定 ID 或默认的已启用插件。
    pub fn resolve_plugin(&self, plugin_id: Option<&str>) -> Result<SymbolicatorPlugin, String> {
        if let Some(id) = plugin_id.map(str::trim).filter(|s| !s.is_empty()) {
            let plugin = self
                .find_plugin(id)
                .ok_or_else(|| format!("未找到插件: {id}"))?;
            if !plugin.enabled {
                return Err(format!("插件「{}」当前已禁用", plugin.name));
            }
            return Ok(plugin);
        }
        let mut combined: Vec<(SymbolicatorPlugin, String)> = self
            .registry
            .plugins
            .iter()
            .cloned()
            .map(|p| (p, "managed".to_string()))
            .collect();
        for discovered in self.load_discovered_plugins() {
            if !combined
                .iter()
                .any(|(existing, _)| existing.id == discovered.id)
            {
                combined.push((discovered, "discovered".to_string()));
            }
        }
        let default_id = self.effective_default_id(&combined);
        if let Some(id) = default_id
            && let Some((plugin, _)) = combined.iter().find(|(p, _)| p.id == id && p.enabled)
        {
            return Ok(plugin.clone());
        }
        combined
            .into_iter()
            .map(|(p, _)| p)
            .find(|p| p.enabled)
            .ok_or_else(|| "尚未配置可用的堆栈还原插件，请先在右上角「插件」中导入或添加".into())
    }

    /// 按 ID 查找任意插件（无论是否启用，用于导出或测试连接）。
    pub fn find_plugin(&self, plugin_id: &str) -> Option<SymbolicatorPlugin> {
        if let Some(found) = self
            .registry
            .plugins
            .iter()
            .find(|item| item.id == plugin_id)
        {
            return Some(found.clone());
        }
        self.load_discovered_plugins()
            .into_iter()
            .find(|item| item.id == plugin_id)
    }

    /// 读取还原缓存。
    pub fn get_cached(&self, key: &str) -> Option<SymbolicateResponse> {
        self.cache.get(key).cloned().map(|mut res| {
            res.cached = true;
            res
        })
    }

    /// 写入还原缓存（按 FIFO/LRU 上限裁剪）。
    pub fn put_cached(&mut self, key: String, response: SymbolicateResponse) {
        if !response.ok {
            return;
        }
        if let std::collections::hash_map::Entry::Occupied(mut entry) =
            self.cache.entry(key.clone())
        {
            entry.insert(response);
            return;
        }
        while self.cache_order.len() >= MAX_CACHE_ENTRIES {
            if let Some(oldest) = self.cache_order.pop_front() {
                self.cache.remove(&oldest);
            }
        }
        self.cache_order.push_back(key.clone());
        self.cache.insert(key, response);
    }

    /// 清空还原结果缓存。
    pub fn clear_cache(&mut self) {
        self.cache.clear();
        self.cache_order.clear();
    }

    fn effective_default_id(&self, combined: &[(SymbolicatorPlugin, String)]) -> Option<String> {
        if let Some(default_id) = &self.registry.default_plugin_id
            && combined.iter().any(|(p, _)| &p.id == default_id)
        {
            return Some(default_id.clone());
        }
        combined
            .iter()
            .find(|(p, _)| p.enabled)
            .or_else(|| combined.first())
            .map(|(p, _)| p.id.clone())
    }

    fn load_discovered_plugins(&self) -> Vec<SymbolicatorPlugin> {
        let Some(dir) = &self.discovery_dir else {
            return Vec::new();
        };
        let Ok(entries) = fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut files: Vec<PathBuf> = entries
            .filter_map(|e| e.ok().map(|item| item.path()))
            .filter(|path| {
                path.is_file()
                    && !path.is_symlink()
                    && matches!(
                        path.extension().and_then(|s| s.to_str()),
                        Some("json") | Some("peekplugin")
                    )
            })
            .collect();
        files.sort();

        let mut results = Vec::new();
        for path in files.into_iter().take(32) {
            if let Ok(meta) = fs::metadata(&path)
                && meta.len() as usize <= MAX_MANIFEST_BYTES
                && let Ok(raw) = fs::read_to_string(&path)
                && let Ok(mut plugin) = serde_json::from_str::<SymbolicatorPlugin>(&raw)
                && validate_plugin(&mut plugin).is_ok()
            {
                results.push(plugin);
            }
        }
        results
    }

    fn persist(&self) -> Result<(), String> {
        let Some(config_file) = &self.config_file else {
            return Ok(());
        };
        if let Some(parent) = config_file.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("无法创建插件配置目录: {e}"))?;
        }
        let body = serde_json::to_string_pretty(&self.registry)
            .map_err(|e| format!("序列化插件配置失败: {e}"))?;
        let tmp = config_file.with_extension("json.tmp");
        fs::write(&tmp, body.as_bytes()).map_err(|e| format!("写入插件配置失败: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
        }
        fs::rename(&tmp, config_file).map_err(|e| format!("保存插件配置失败: {e}"))?;
        Ok(())
    }
}

fn default_discovery_dir() -> Option<PathBuf> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
    let path = PathBuf::from(home);
    path.is_absolute()
        .then(|| path.join(".peek-desktop").join("plugins"))
}

fn mask_secret(secret: Option<&str>) -> Option<String> {
    let trimmed = secret?.trim();
    if trimmed.is_empty() {
        return None;
    }
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= 8 {
        Some("••••••••".to_string())
    } else {
        let prefix: String = chars[..4].iter().collect();
        let suffix: String = chars[chars.len() - 4..].iter().collect();
        Some(format!("{prefix}••••{suffix}"))
    }
}

fn to_plugin_view(plugin: &SymbolicatorPlugin, source: String, is_default: bool) -> PluginView {
    let masked_token = plugin
        .http
        .as_ref()
        .and_then(|h| mask_secret(h.token.as_deref()));
    let has_secret = masked_token.is_some();
    let http = plugin.http.as_ref().map(|h| HttpPluginView {
        endpoint: h.endpoint.clone(),
        health_endpoint: h.health_endpoint.clone(),
        auth_header: h.auth_header.clone(),
        has_token: masked_token.is_some(),
        masked_token: masked_token.clone(),
        headers: h.headers.clone(),
    });
    PluginView {
        schema_version: plugin.schema_version,
        id: plugin.id.clone(),
        name: plugin.name.clone(),
        description: plugin.description.clone(),
        enabled: plugin.enabled,
        kind: plugin.kind.clone(),
        timeout_ms: plugin.timeout_ms,
        source,
        is_default,
        has_secret,
        masked_token,
        local: plugin.local.clone(),
        http,
        cli: plugin.cli.clone(),
    }
}

/// 严格校验插件定义，防止注入、畸形协议或非法 URL。
pub fn validate_plugin(plugin: &mut SymbolicatorPlugin) -> Result<(), String> {
    if plugin.schema_version != PLUGIN_SCHEMA_VERSION {
        return Err(format!(
            "不支持的插件清单版本: {}（当前支持 v{}）",
            plugin.schema_version, PLUGIN_SCHEMA_VERSION
        ));
    }
    plugin.id = plugin.id.trim().to_ascii_lowercase();
    plugin.name = plugin.name.trim().to_string();
    if plugin.id.is_empty()
        || plugin.id.len() > 64
        || !plugin.id.as_bytes()[0].is_ascii_alphanumeric()
        || !plugin.id.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_' | b'.')
        })
    {
        return Err("插件 ID 仅支持小写字母、数字和 - _ .，且长度不超过 64".into());
    }
    if plugin.name.is_empty() || plugin.name.len() > 80 {
        return Err("插件名称不能为空且不超过 80 个字符".into());
    }
    if plugin.timeout_ms == 0 {
        plugin.timeout_ms = DEFAULT_TIMEOUT_MS;
    }
    plugin.timeout_ms = plugin.timeout_ms.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);

    match plugin.kind {
        PluginKind::Local => {
            let local = plugin
                .local
                .as_mut()
                .ok_or("本地符号插件缺少 local 配置块")?;
            local.symbols_dir = local.symbols_dir.trim().to_string();
            if local.symbols_dir.is_empty() {
                return Err("本地符号目录路径不能为空".into());
            }
            if let Some(bin) = &mut local.flutter_bin {
                let trimmed = bin.trim().to_string();
                if trimmed.is_empty() {
                    local.flutter_bin = None;
                } else {
                    *bin = trimmed;
                }
            }
            plugin.http = None;
            plugin.cli = None;
        }
        PluginKind::Http => {
            let http = plugin.http.as_mut().ok_or("HTTP 插件缺少 http 配置块")?;
            http.endpoint = http.endpoint.trim().to_string();
            validate_http_url(&http.endpoint, "服务地址")?;
            if let Some(health) = &mut http.health_endpoint {
                let trimmed = health.trim().to_string();
                if trimmed.is_empty() {
                    http.health_endpoint = None;
                } else {
                    validate_http_url(&trimmed, "健康检查地址")?;
                    *health = trimmed;
                }
            }
            if let Some(header) = &mut http.auth_header {
                let trimmed = header.trim().to_string();
                if trimmed.is_empty() {
                    http.auth_header = None;
                } else {
                    *header = trimmed;
                }
            }
            plugin.local = None;
            plugin.cli = None;
        }
        PluginKind::Cli => {
            let cli = plugin.cli.as_mut().ok_or("CLI 插件缺少 cli 配置块")?;
            cli.command = cli.command.trim().to_string();
            if cli.command.is_empty() {
                return Err("CLI 可执行命令不能为空".into());
            }
            if cli.command.contains('\n') || cli.command.contains('\0') {
                return Err("CLI 命令包含非法字符".into());
            }
            if let Some(dir) = &mut cli.working_dir {
                let trimmed = dir.trim().to_string();
                if trimmed.is_empty() {
                    cli.working_dir = None;
                } else {
                    *dir = trimmed;
                }
            }
            plugin.local = None;
            plugin.http = None;
        }
    }
    Ok(())
}

fn validate_http_url(raw: &str, label: &str) -> Result<(), String> {
    let parsed = url::Url::parse(raw).map_err(|_| format!("{label}不是合法的 URL"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("{label}仅支持 http 或 https 协议"));
    }
    if parsed.host_str().is_none() {
        return Err(format!("{label}缺少主机名"));
    }
    Ok(())
}

/// 解析 `.peekplugin.json` 内容或 `peek-desktop://plugin?v=1&data=<base64url>` 安装链接。
pub fn parse_plugin_package(raw_input: &str) -> Result<ParsedPluginPreview, String> {
    let trimmed = raw_input.trim();
    if trimmed.is_empty() {
        return Err("插件配置内容为空".into());
    }
    if trimmed.len() > MAX_MANIFEST_BYTES {
        return Err("插件配置文件超过 256 KiB 上限".into());
    }

    let json_text = if trimmed.starts_with("peek-desktop://") {
        let parsed_url = url::Url::parse(trimmed).map_err(|_| "无效的插件安装链接")?;
        if parsed_url.host_str() != Some("plugin") {
            return Err("该链接不是 Peek 插件安装链接（需以 peek-desktop://plugin 开头）".into());
        }
        let encoded = parsed_url
            .query_pairs()
            .find(|(k, _)| k == "data")
            .map(|(_, v)| v.into_owned())
            .ok_or("插件安装链接缺少 data 参数")?;
        let decoded = URL_SAFE_NO_PAD
            .decode(encoded.trim_end_matches('='))
            .map_err(|_| "插件安装链接 data 解码失败")?;
        if decoded.len() > MAX_MANIFEST_BYTES {
            return Err("插件配置内容超过 256 KiB 上限".into());
        }
        String::from_utf8(decoded).map_err(|_| "插件配置不是合法的 UTF-8 文本")?
    } else {
        trimmed.to_string()
    };

    let raw_val: Value =
        serde_json::from_str(&json_text).map_err(|e| format!("插件 JSON 解析失败: {e}"))?;
    let service_info = raw_val
        .get("serviceInfo")
        .and_then(|v| serde_json::from_value::<ServiceDiscoveryInfo>(v.clone()).ok());
    let mut plugin: SymbolicatorPlugin =
        serde_json::from_value(raw_val).map_err(|e| format!("插件清单字段无效: {e}"))?;
    validate_plugin(&mut plugin)?;
    let masked_token = plugin
        .http
        .as_ref()
        .and_then(|h| mask_secret(h.token.as_deref()));
    let has_secret = masked_token.is_some();
    let requires_trust_warning = plugin.kind == PluginKind::Cli;
    Ok(ParsedPluginPreview {
        plugin,
        has_secret,
        masked_token,
        requires_trust_warning,
        service_info,
    })
}

/// 通过单个服务地址（自动探测 `/manifest` 与 `/.well-known/peek-plugin.json`）一键拉取完整插件配置。
pub async fn fetch_plugin_from_url(
    raw_url: &str,
    explicit_token: Option<&str>,
) -> Result<ParsedPluginPreview, String> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return Err("请输入符号化服务地址".into());
    }
    let normalized = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let mut parsed = url::Url::parse(&normalized).map_err(|_| "服务地址不是合法的 URL")?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("服务地址仅支持 http 或 https 协议".into());
    }

    // 优先使用显式传入的 Token，否则提取 URL 查询参数里的 ?token=... 并从 URL 中剥离
    let query_token = parsed
        .query_pairs()
        .find(|(k, _)| k.eq_ignore_ascii_case("token"))
        .map(|(_, v)| v.into_owned())
        .filter(|s| !s.trim().is_empty());
    let effective_token = explicit_token
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or(query_token);

    let mut clean_base = parsed.clone();
    clean_base.set_query(None);
    clean_base.set_fragment(None);

    let mut candidates: Vec<String> = Vec::new();
    let orig_path = parsed.path().to_string();
    if orig_path != "/" && !orig_path.is_empty() {
        candidates.push(clean_base.to_string());
    }
    for suffix in ["/manifest", "/.well-known/peek-plugin.json"] {
        let mut probe = clean_base.clone();
        probe.set_path(suffix);
        let url_str = probe.to_string();
        if !candidates.contains(&url_str) {
            candidates.push(url_str);
        }
    }
    if orig_path == "/" || orig_path.is_empty() {
        let root_str = clean_base.to_string();
        if !candidates.contains(&root_str) {
            candidates.push(root_str);
        }
    }
    let _ = &mut parsed;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| format!("初始化 HTTP 客户端失败: {e}"))?;

    let mut last_error = "无法从该地址拉取插件清单".to_string();
    for candidate in candidates {
        let mut req = client
            .get(&candidate)
            .header(reqwest::header::ACCEPT, "application/json");
        if let Some(tok) = &effective_token {
            req = req.header(reqwest::header::AUTHORIZATION, format!("Bearer {tok}"));
        }
        let resp = match req.send().await {
            Ok(r) => r,
            Err(err) => {
                last_error = format!("连接服务失败 ({candidate}): {err}");
                continue;
            }
        };
        let status = resp.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err("服务端需要访问令牌，请填写正确的只读 Token 后重新拉取".into());
        }
        if !status.is_success() {
            last_error = format!("拉取清单失败（HTTP {}）", status.as_u16());
            continue;
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("读取服务端清单失败: {e}"))?;
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err("服务端返回的插件清单超过 256 KiB 上限".into());
        }
        let text = String::from_utf8(bytes.to_vec())
            .map_err(|_| "服务端返回的插件清单不是有效 UTF-8 文本")?;
        let mut preview = match parse_plugin_package(&text) {
            Ok(p) => p,
            Err(err) => {
                last_error = err;
                continue;
            }
        };
        // 将拉取时验证通过的 Token 自动回填到 HTTP 插件配置中，实现一键可用
        if preview.plugin.kind == PluginKind::Http
            && let Some(http) = preview.plugin.http.as_mut()
            && http
                .token
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
            && let Some(tok) = &effective_token
        {
            http.token = Some(tok.clone());
            preview.masked_token = mask_secret(Some(tok));
            preview.has_secret = preview.masked_token.is_some();
        }
        return Ok(preview);
    }

    Err(last_error)
}

/// 从本地 `.peekplugin.json` / `.peekplugin` 文件读取并预览插件定义。
pub fn parse_plugin_file(path: &Path) -> Result<ParsedPluginPreview, String> {
    let meta = fs::metadata(path).map_err(|e| format!("无法读取插件文件: {e}"))?;
    if !meta.is_file() {
        return Err("请选择普通插件清单文件".into());
    }
    if meta.len() as usize > MAX_MANIFEST_BYTES {
        return Err("插件清单文件过大（上限 256 KiB）".into());
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("读取插件文件失败: {e}"))?;
    parse_plugin_package(&raw)
}

/// 导出 `.peekplugin.json` 文本与 `peek-desktop://plugin?...` 分享链接；默认剥离敏感密钥。
pub fn export_plugin_bundle(
    plugin: &SymbolicatorPlugin,
    include_secrets: bool,
) -> Result<(String, String), String> {
    let mut sanitized = plugin.clone();
    if !include_secrets && let Some(http) = sanitized.http.as_mut() {
        http.token = None;
        http.headers
            .retain(|k, _| !k.eq_ignore_ascii_case("authorization"));
    }
    let pretty =
        serde_json::to_string_pretty(&sanitized).map_err(|e| format!("导出 JSON 失败: {e}"))?;
    let compact = serde_json::to_string(&sanitized).map_err(|e| format!("编码链接失败: {e}"))?;
    let link = format!(
        "peek-desktop://plugin?v={}&data={}",
        PLUGIN_SCHEMA_VERSION,
        URL_SAFE_NO_PAD.encode(compact.as_bytes())
    );
    Ok((pretty, link))
}

/// 计算堆栈还原缓存键（结合插件 ID、核心配置摘要与堆栈指纹）。
pub fn cache_key(plugin: &SymbolicatorPlugin, req: &SymbolicateRequest) -> String {
    let mut hasher = Sha256::new();
    hasher.update(plugin.id.as_bytes());
    hasher.update(b"\x00");
    if let Ok(cfg) = serde_json::to_string(plugin) {
        hasher.update(cfg.as_bytes());
    }
    hasher.update(b"\x00");
    hasher.update(req.stack_trace.as_bytes());
    hasher.update(b"\x00");
    for field in [
        req.build_id.as_deref(),
        req.platform.as_deref(),
        req.arch.as_deref(),
        req.app_version.as_deref(),
        req.build_number.as_deref(),
        req.flavor.as_deref(),
        req.brand.as_deref(),
        req.job_id.as_deref(),
    ] {
        hasher.update(field.unwrap_or("").as_bytes());
        hasher.update(b"\x1f");
    }
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

/// 执行堆栈还原主流程。
pub async fn execute_symbolicate(
    plugin: &SymbolicatorPlugin,
    req: &SymbolicateRequest,
) -> SymbolicateResponse {
    let started = Instant::now();
    let detected = elf::parse_aot_stack(&req.stack_trace);
    let effective_build_id = req
        .build_id
        .as_deref()
        .map(elf::normalize_hex_id)
        .filter(|s| !s.is_empty())
        .or_else(|| detected.build_id.clone());
    let effective_platform = req
        .platform
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_ascii_lowercase)
        .or_else(|| detected.os.clone());
    let effective_arch = req
        .arch
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_ascii_lowercase)
        .or_else(|| detected.arch.clone());

    let payload = json!({
        "action": "symbolicate",
        "schemaVersion": PLUGIN_SCHEMA_VERSION,
        "stackTrace": req.stack_trace,
        "stackFormat": req.stack_format.clone().unwrap_or_else(|| "dart".to_string()),
        "buildId": effective_build_id,
        "platform": effective_platform,
        "arch": effective_arch,
        "appVersion": req.app_version,
        "buildNumber": req.build_number,
        "flavor": req.flavor,
        "brand": req.brand,
        "jobId": req.job_id,
        "attributes": req.attributes,
    });

    let outcome = match plugin.kind {
        PluginKind::Local => {
            let local = plugin.local.clone().unwrap_or_default();
            let stack = req.stack_trace.clone();
            let timeout = Duration::from_millis(plugin.timeout_ms);
            let bid = effective_build_id.clone();
            let plat = effective_platform.clone();
            let arch = effective_arch.clone();
            execute_local_symbolicate(local, stack, bid, plat, arch, timeout).await
        }
        PluginKind::Http => {
            let http = plugin.http.clone().unwrap_or_default();
            execute_http_symbolicate(&http, &payload, Duration::from_millis(plugin.timeout_ms))
                .await
        }
        PluginKind::Cli => {
            let cli = plugin.cli.clone().unwrap_or_default();
            execute_cli_symbolicate(&cli, &payload, Duration::from_millis(plugin.timeout_ms)).await
        }
    };

    let duration_ms = started.elapsed().as_millis() as u64;
    match outcome {
        Ok(res) => SymbolicateResponse {
            ok: true,
            symbolized_stack: Some(res.symbolized_stack),
            provider_id: plugin.id.clone(),
            provider_name: plugin.name.clone(),
            cached: false,
            duration_ms,
            detected,
            matched_build: res.matched_build,
            warnings: res.warnings,
            error: None,
        },
        Err(error) => SymbolicateResponse {
            ok: false,
            symbolized_stack: None,
            provider_id: plugin.id.clone(),
            provider_name: plugin.name.clone(),
            cached: false,
            duration_ms,
            detected,
            matched_build: None,
            warnings: Vec::new(),
            error: Some(error),
        },
    }
}

/// 测试插件连通性 / 可用性。
pub async fn test_plugin(plugin: &SymbolicatorPlugin) -> PluginTestResult {
    let started = Instant::now();
    let timeout = Duration::from_millis(plugin.timeout_ms.min(15_000));
    match plugin.kind {
        PluginKind::Local => {
            let local = plugin.local.clone().unwrap_or_default();
            let outcome = tokio::task::spawn_blocking(move || test_local_provider(&local))
                .await
                .unwrap_or_else(|_| Err("内部检查任务异常终止".into()));
            let latency_ms = started.elapsed().as_millis() as u64;
            match outcome {
                Ok((count, details)) => PluginTestResult {
                    ok: true,
                    message: format!("本地符号目录可用，发现 {count} 个符号文件"),
                    latency_ms,
                    available_builds: Some(count),
                    details: Some(details),
                    recent_builds: Vec::new(),
                },
                Err(error) => PluginTestResult {
                    ok: false,
                    message: error,
                    latency_ms,
                    available_builds: None,
                    details: None,
                    recent_builds: Vec::new(),
                },
            }
        }
        PluginKind::Http => {
            let http = plugin.http.clone().unwrap_or_default();
            let outcome = test_http_provider(&http, timeout).await;
            let latency_ms = started.elapsed().as_millis() as u64;
            match outcome {
                Ok((builds, msg, recent_builds)) => PluginTestResult {
                    ok: true,
                    message: msg,
                    latency_ms,
                    available_builds: builds,
                    details: Some(http.endpoint),
                    recent_builds,
                },
                Err(error) => PluginTestResult {
                    ok: false,
                    message: error,
                    latency_ms,
                    available_builds: None,
                    details: None,
                    recent_builds: Vec::new(),
                },
            }
        }
        PluginKind::Cli => {
            let cli = plugin.cli.clone().unwrap_or_default();
            let payload = json!({
                "action": "health",
                "schemaVersion": PLUGIN_SCHEMA_VERSION,
            });
            let outcome = run_cli_json(&cli, &payload, timeout).await;
            let latency_ms = started.elapsed().as_millis() as u64;
            match outcome {
                Ok(val) => {
                    let ok = val.get("ok").and_then(Value::as_bool).unwrap_or(true);
                    let message = val
                        .get("message")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| {
                            if ok {
                                "CLI 插件响应正常".into()
                            } else {
                                "CLI 插件返回异常状态".into()
                            }
                        });
                    let available_builds = val
                        .get("availableBuilds")
                        .and_then(Value::as_u64)
                        .or_else(|| val.get("symbolCount").and_then(Value::as_u64));
                    let recent_builds = val
                        .get("recentBuilds")
                        .and_then(|v| {
                            serde_json::from_value::<Vec<ServiceBuildSummary>>(v.clone()).ok()
                        })
                        .unwrap_or_default();
                    PluginTestResult {
                        ok,
                        message,
                        latency_ms,
                        available_builds,
                        details: val.get("error").and_then(Value::as_str).map(str::to_string),
                        recent_builds,
                    }
                }
                Err(error) => PluginTestResult {
                    ok: false,
                    message: error,
                    latency_ms,
                    available_builds: None,
                    details: None,
                    recent_builds: Vec::new(),
                },
            }
        }
    }
}

struct ProviderSuccess {
    symbolized_stack: String,
    matched_build: Option<MatchedBuildInfo>,
    warnings: Vec<String>,
}

fn parse_provider_payload(val: Value) -> Result<ProviderSuccess, String> {
    if val.get("ok").and_then(Value::as_bool) == Some(false) {
        let err = val
            .get("error")
            .and_then(Value::as_str)
            .or_else(|| val.get("message").and_then(Value::as_str))
            .unwrap_or("插件返回还原失败");
        return Err(err.to_string());
    }
    let symbolized_stack = val
        .get("symbolizedStack")
        .or_else(|| val.get("stackTrace"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|s| !s.trim().is_empty())
        .ok_or("插件返回中缺少 symbolizedStack 内容")?;
    let matched_build = val
        .get("matchedBuild")
        .and_then(|v| serde_json::from_value::<MatchedBuildInfo>(v.clone()).ok());
    let warnings = val
        .get("warnings")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    Ok(ProviderSuccess {
        symbolized_stack,
        matched_build,
        warnings,
    })
}

async fn execute_http_symbolicate(
    http: &HttpPluginConfig,
    payload: &Value,
    timeout: Duration,
) -> Result<ProviderSuccess, String> {
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("初始化 HTTP 客户端失败: {e}"))?;

    let mut req = client
        .post(&http.endpoint)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "application/json");
    req = apply_http_headers(req, http);

    let response = req
        .body(payload.to_string())
        .send()
        .await
        .map_err(|e| format!("请求符号化服务失败: {e}"))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取服务响应失败: {e}"))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("符号化服务响应体积超出 2 MiB 上限".into());
    }
    if !status.is_success() {
        if let Ok(err_json) = serde_json::from_slice::<Value>(&bytes)
            && let Some(msg) = err_json
                .get("error")
                .or_else(|| err_json.get("message"))
                .and_then(Value::as_str)
        {
            return Err(format!("服务返回 HTTP {}: {msg}", status.as_u16()));
        }
        return Err(format!("服务返回 HTTP {}", status.as_u16()));
    }
    let val: Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("服务返回的 JSON 无效: {e}"))?;
    parse_provider_payload(val)
}

async fn test_http_provider(
    http: &HttpPluginConfig,
    timeout: Duration,
) -> Result<(Option<u64>, String, Vec<ServiceBuildSummary>), String> {
    let health_url = if let Some(explicit) = &http.health_endpoint {
        explicit.clone()
    } else {
        let mut parsed = url::Url::parse(&http.endpoint).map_err(|_| "服务地址无效")?;
        parsed.set_path("/health");
        parsed.set_query(None);
        parsed.to_string()
    };

    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("初始化 HTTP 客户端失败: {e}"))?;
    let mut req = client
        .get(&health_url)
        .header(reqwest::header::ACCEPT, "application/json");
    req = apply_http_headers(req, http);
    let response = req
        .send()
        .await
        .map_err(|e| format!("连接健康检查接口失败: {e}"))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取健康检查响应失败: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "健康检查失败（HTTP {}），请检查地址或访问令牌",
            status.as_u16()
        ));
    }
    if let Ok(val) = serde_json::from_slice::<Value>(&bytes) {
        let builds = val
            .get("availableBuilds")
            .or_else(|| val.get("symbolCount"))
            .and_then(Value::as_u64);
        let recent_builds = val
            .get("recentBuilds")
            .and_then(|v| serde_json::from_value::<Vec<ServiceBuildSummary>>(v.clone()).ok())
            .unwrap_or_default();
        let msg = val
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| match builds {
                Some(n) => format!("连接成功，服务端已索引 {n} 个符号构建"),
                None => "HTTP 符号化服务连接正常".into(),
            });
        return Ok((builds, msg, recent_builds));
    }
    Ok((None, "HTTP 符号化服务连接正常".into(), Vec::new()))
}

fn apply_http_headers(
    mut req: reqwest::RequestBuilder,
    http: &HttpPluginConfig,
) -> reqwest::RequestBuilder {
    for (k, v) in &http.headers {
        req = req.header(k.as_str(), v.as_str());
    }
    if let Some(token) = http
        .token
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if let Some(header) = http
            .auth_header
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            req = req.header(header, token);
        } else {
            req = req.header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"));
        }
    }
    req
}

async fn execute_cli_symbolicate(
    cli: &CliPluginConfig,
    payload: &Value,
    timeout: Duration,
) -> Result<ProviderSuccess, String> {
    let val = run_cli_json(cli, payload, timeout).await?;
    parse_provider_payload(val)
}

fn run_blocking_process_with_timeout(
    mut cmd: Command,
    stdin_bytes: Vec<u8>,
    timeout: Duration,
    label: &str,
) -> Result<Output, String> {
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("启动 {label} 失败: {e}"))?;

    let mut stdin_pipe = child.stdin.take();
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let writer = std::thread::spawn(move || {
        if let Some(mut stdin) = stdin_pipe.take() {
            let _ = stdin.write_all(&stdin_bytes);
            let _ = stdin.flush();
        }
    });
    let stdout_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut out) = stdout_pipe {
            let mut limited = out.by_ref().take((MAX_RESPONSE_BYTES + 1) as u64);
            let _ = limited.read_to_end(&mut buf);
        }
        buf
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut err) = stderr_pipe {
            let mut limited = err.by_ref().take(64 * 1024);
            let _ = limited.read_to_end(&mut buf);
        }
        buf
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = writer.join();
                    let _ = stdout_reader.join();
                    let _ = stderr_reader.join();
                    return Err(format!("{label} 执行超时（>{}ms）", timeout.as_millis()));
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => {
                let _ = child.kill();
                return Err(format!("等待 {label} 失败: {e}"));
            }
        }
    };

    let _ = writer.join();
    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

async fn run_cli_json(
    cli: &CliPluginConfig,
    payload: &Value,
    timeout: Duration,
) -> Result<Value, String> {
    let cli = cli.clone();
    let input = payload.to_string().into_bytes();
    let output = tokio::task::spawn_blocking(move || {
        let command_path = expand_home_path(&cli.command);
        let mut cmd = Command::new(&command_path);
        cmd.args(cli.args.iter().map(|a| expand_home_str(a)));
        if let Some(dir) = &cli.working_dir {
            cmd.current_dir(expand_home_path(dir));
        }
        for (k, v) in &cli.env {
            cmd.env(k, expand_home_str(v));
        }
        let label = format!("CLI 插件 ({})", command_path.display());
        run_blocking_process_with_timeout(cmd, input, timeout, &label)
    })
    .await
    .map_err(|_| "CLI 插件任务异常终止".to_string())??;

    if output.stdout.len() > MAX_RESPONSE_BYTES {
        return Err("CLI 插件输出超过 2 MiB 上限".into());
    }
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if let Ok(val) = serde_json::from_slice::<Value>(&output.stdout)
            && let Some(err) = val.get("error").and_then(Value::as_str)
        {
            return Err(err.to_string());
        }
        return Err(if stderr.is_empty() {
            format!("CLI 插件退出码非零 ({:?})", output.status.code())
        } else {
            format!("CLI 插件执行失败: {stderr}")
        });
    }

    serde_json::from_slice::<Value>(&output.stdout)
        .map_err(|e| format!("CLI 插件未返回合法 JSON: {e}"))
}

async fn execute_local_symbolicate(
    local: LocalPluginConfig,
    stack_trace: String,
    build_id: Option<String>,
    platform: Option<String>,
    arch: Option<String>,
    timeout: Duration,
) -> Result<ProviderSuccess, String> {
    let local_for_scan = local.clone();
    let (symbol_file, matched_by) = tokio::task::spawn_blocking(move || {
        find_local_symbol_file(
            &expand_home_path(&local_for_scan.symbols_dir),
            build_id.as_deref(),
            platform.as_deref(),
            arch.as_deref(),
        )
    })
    .await
    .map_err(|_| "扫描本地符号目录失败".to_string())??;

    let flutter_bin = resolve_flutter_binary(local.flutter_bin.as_deref())?;
    let symbol_for_cmd = symbol_file.clone();
    let output = tokio::task::spawn_blocking(move || {
        let mut cmd = Command::new(&flutter_bin);
        cmd.arg("symbolize").arg("-d").arg(&symbol_for_cmd);
        let label = format!("flutter symbolize ({})", flutter_bin.display());
        run_blocking_process_with_timeout(cmd, stack_trace.into_bytes(), timeout, &label)
    })
    .await
    .map_err(|_| "flutter symbolize 任务异常终止".to_string())??;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "flutter symbolize 还原失败".into()
        } else {
            format!("flutter symbolize 还原失败: {stderr}")
        });
    }
    let symbolized = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if symbolized.is_empty() {
        return Err("flutter symbolize 返回为空，请确认符号文件与安装包匹配".into());
    }

    Ok(ProviderSuccess {
        symbolized_stack: symbolized,
        matched_build: Some(MatchedBuildInfo {
            matched_by: Some(matched_by),
            symbol_file: symbol_file
                .file_name()
                .map(|n| n.to_string_lossy().to_string()),
            ..Default::default()
        }),
        warnings: Vec::new(),
    })
}

fn test_local_provider(local: &LocalPluginConfig) -> Result<(u64, String), String> {
    let dir = expand_home_path(&local.symbols_dir);
    if !dir.exists() {
        return Err(format!("本地符号路径不存在: {}", dir.display()));
    }
    let files = collect_symbol_files(&dir, 6);
    if files.is_empty() {
        return Err("指定路径下未找到任何 .symbols 文件".into());
    }
    let flutter = resolve_flutter_binary(local.flutter_bin.as_deref())?;
    Ok((
        files.len() as u64,
        format!("Flutter CLI: {}", flutter.display()),
    ))
}

fn find_local_symbol_file(
    dir: &Path,
    build_id: Option<&str>,
    platform: Option<&str>,
    arch: Option<&str>,
) -> Result<(PathBuf, String), String> {
    if dir.is_file() {
        return Ok((dir.to_path_buf(), "directFile".into()));
    }
    let files = collect_symbol_files(dir, 6);
    if files.is_empty() {
        return Err("本地目录中未找到 .symbols 符号文件".into());
    }

    if let Some(target_id) = build_id.filter(|s| !s.is_empty()) {
        for candidate in &files {
            if let Some(file_id) = elf::extract_symbol_build_id(candidate)
                && file_id.eq_ignore_ascii_case(target_id)
            {
                return Ok((candidate.clone(), "buildId".into()));
            }
        }
        return Err(format!(
            "本地目录扫描了 {} 个符号文件，均未匹配到 build_id={target_id}",
            files.len()
        ));
    }

    // 无 build_id 时按平台与架构名称匹配最近修改的文件
    let mut best: Option<(i32, std::time::SystemTime, PathBuf)> = None;
    for candidate in files {
        let name = candidate
            .file_name()
            .map(|s| s.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        let mut score = 0;
        if let Some(p) = platform
            && name.contains(p)
        {
            score += 4;
        }
        if let Some(a) = arch
            && name.contains(a)
        {
            score += 4;
        }
        let mtime = fs::metadata(&candidate)
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        let better = match &best {
            None => true,
            Some((best_score, best_mtime, _)) => {
                score > *best_score || (score == *best_score && mtime > *best_mtime)
            }
        };
        if better {
            best = Some((score, mtime, candidate));
        }
    }
    best.map(|(_, _, path)| (path, "filenameFallback".into()))
        .ok_or_else(|| "未找到匹配的本地符号文件".into())
}

fn collect_symbol_files(root: &Path, max_depth: usize) -> Vec<PathBuf> {
    let mut out = Vec::new();
    collect_symbol_files_inner(root, max_depth, &mut out);
    out
}

fn collect_symbol_files_inner(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth == 0 || out.len() >= 256 || dir.is_symlink() {
        return;
    }
    if dir.is_file() {
        if is_symbol_file(dir) {
            out.push(dir.to_path_buf());
        }
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_symlink() {
            continue;
        }
        if path.is_dir() {
            collect_symbol_files_inner(&path, depth - 1, out);
        } else if is_symbol_file(&path) {
            out.push(path);
            if out.len() >= 256 {
                return;
            }
        }
    }
}

fn is_symbol_file(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|s| s.to_str()),
        Some("symbols") | Some("sym")
    )
}

fn resolve_flutter_binary(explicit: Option<&str>) -> Result<PathBuf, String> {
    if let Some(raw) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        let path = expand_home_path(raw);
        if path.is_file() {
            return Ok(path);
        }
        return Err(format!(
            "指定的 Flutter 可执行文件不存在: {}",
            path.display()
        ));
    }
    let exe_name = if cfg!(windows) {
        "flutter.bat"
    } else {
        "flutter"
    };
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(exe_name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        let home_path = PathBuf::from(home);
        for rel in [
            "fvm/default/bin/flutter",
            "development/flutter/bin/flutter",
            "flutter/bin/flutter",
        ] {
            let candidate = home_path.join(rel);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err(
        "本机未找到 flutter CLI；请在插件设置中指定 Flutter 路径，或改用远端 HTTP 符号化服务"
            .into(),
    )
}

fn expand_home_str(raw: &str) -> String {
    if let Some(rest) = raw.strip_prefix("~/")
        && let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
    {
        return PathBuf::from(home).join(rest).to_string_lossy().to_string();
    }
    raw.to_string()
}

fn expand_home_path(raw: &str) -> PathBuf {
    PathBuf::from(expand_home_str(raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_export_bundle_and_strips_secrets_by_default() {
        let plugin = SymbolicatorPlugin {
            schema_version: 1,
            id: "team-http".into(),
            name: "团队符号化服务".into(),
            description: Some("内网只读还原".into()),
            enabled: true,
            kind: PluginKind::Http,
            timeout_ms: 15_000,
            local: None,
            http: Some(HttpPluginConfig {
                endpoint: "https://symbols.example.internal/v1/symbolize".into(),
                health_endpoint: None,
                auth_header: None,
                token: Some("secret-token-123456".into()),
                headers: BTreeMap::from([
                    ("X-Team".into(), "qa".into()),
                    ("Authorization".into(), "Bearer leak".into()),
                ]),
            }),
            cli: None,
        };

        let (redacted_json, link) = export_plugin_bundle(&plugin, false).unwrap();
        assert!(!redacted_json.contains("secret-token-123456"));
        assert!(!redacted_json.contains("Bearer leak"));
        assert!(link.starts_with("peek-desktop://plugin?v=1&data="));

        let parsed_from_link = parse_plugin_package(&link).unwrap();
        assert_eq!(parsed_from_link.plugin.id, "team-http");
        assert!(!parsed_from_link.has_secret);
        assert!(!parsed_from_link.requires_trust_warning);

        let (full_json, full_link) = export_plugin_bundle(&plugin, true).unwrap();
        assert!(full_json.contains("secret-token-123456"));
        let parsed_full = parse_plugin_package(&full_link).unwrap();
        assert!(parsed_full.has_secret);
        assert_eq!(
            parsed_full.plugin.http.unwrap().token.as_deref(),
            Some("secret-token-123456")
        );
    }

    #[test]
    fn manager_persists_keeps_existing_secret_and_supports_discovered_dir() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join("managed/config.json");
        let disc = dir.path().join("discovered");
        fs::create_dir_all(&disc).unwrap();
        fs::write(
            disc.join("external.peekplugin.json"),
            serde_json::to_string(&SymbolicatorPlugin {
                schema_version: 1,
                id: "ext-http".into(),
                name: "外部发现插件".into(),
                description: None,
                enabled: true,
                kind: PluginKind::Http,
                timeout_ms: 10_000,
                local: None,
                http: Some(HttpPluginConfig {
                    endpoint: "http://127.0.0.1:17890/v1/symbolize".into(),
                    ..Default::default()
                }),
                cli: None,
            })
            .unwrap(),
        )
        .unwrap();

        let mut mgr = PluginManager::default();
        mgr.initialize_for_test(cfg.clone(), Some(disc));

        let snap = mgr
            .upsert(
                SymbolicatorPlugin {
                    schema_version: 1,
                    id: "qa-http".into(),
                    name: "测试服符号服务".into(),
                    description: None,
                    enabled: true,
                    kind: PluginKind::Http,
                    timeout_ms: 15_000,
                    local: None,
                    http: Some(HttpPluginConfig {
                        endpoint: "http://127.0.0.1:17890/v1/symbolize".into(),
                        token: Some("qa-secret-998877".into()),
                        ..Default::default()
                    }),
                    cli: None,
                },
                false,
                true,
            )
            .unwrap();
        assert_eq!(snap.plugins.len(), 2);
        assert_eq!(snap.default_plugin_id.as_deref(), Some("qa-http"));

        // 编辑时不填 token，自动保留原密钥
        mgr.upsert(
            SymbolicatorPlugin {
                schema_version: 1,
                id: "qa-http".into(),
                name: "测试服符号服务(更新)".into(),
                description: None,
                enabled: true,
                kind: PluginKind::Http,
                timeout_ms: 15_000,
                local: None,
                http: Some(HttpPluginConfig {
                    endpoint: "http://127.0.0.1:17890/v1/symbolize".into(),
                    token: None,
                    ..Default::default()
                }),
                cli: None,
            },
            true,
            false,
        )
        .unwrap();
        let saved = mgr.find_plugin("qa-http").unwrap();
        assert_eq!(
            saved.http.unwrap().token.as_deref(),
            Some("qa-secret-998877")
        );
    }

    #[tokio::test]
    async fn executes_cli_provider_with_standard_json_contract() {
        // 使用本机 python3 作为极简标准 CLI Provider 桩测试端到端协议
        let plugin = SymbolicatorPlugin {
            schema_version: 1,
            id: "mock-cli".into(),
            name: "Mock CLI".into(),
            description: None,
            enabled: true,
            kind: PluginKind::Cli,
            timeout_ms: 10_000,
            local: None,
            http: None,
            cli: Some(CliPluginConfig {
                command: if cfg!(windows) { "python" } else { "python3" }.into(),
                args: vec![
                    "-c".into(),
                    "import json,sys; req=json.load(sys.stdin); print(json.dumps({'ok':True,'symbolizedStack':'#0 login (package:demo/login.dart:42:9)','matchedBuild':{'jobId':'job-1','matchedBy':'buildId'}} if req.get('action')=='symbolicate' else {'ok':True,'availableBuilds':3,'message':'ready'}))".into(),
                ],
                working_dir: None,
                env: BTreeMap::new(),
            }),
        };

        let health = test_plugin(&plugin).await;
        assert!(health.ok);
        assert_eq!(health.available_builds, Some(3));

        let res = execute_symbolicate(
            &plugin,
            &SymbolicateRequest {
                plugin_id: Some("mock-cli".into()),
                stack_trace: "build_id: 'abcdef01'\n#00 abs 00000104e2a1bc".into(),
                stack_format: Some("dart".into()),
                build_id: None,
                platform: None,
                arch: None,
                app_version: Some("1.0.0".into()),
                build_number: Some("100".into()),
                flavor: Some("dev".into()),
                brand: None,
                job_id: None,
                attributes: None,
                force_refresh: false,
            },
        )
        .await;
        assert!(res.ok);
        assert!(res.detected.is_aot);
        assert_eq!(res.detected.build_id.as_deref(), Some("abcdef01"));
        assert_eq!(
            res.symbolized_stack.as_deref(),
            Some("#0 login (package:demo/login.dart:42:9)")
        );
        assert_eq!(
            res.matched_build.as_ref().and_then(|b| b.job_id.as_deref()),
            Some("job-1")
        );
    }

    #[tokio::test]
    async fn fetches_plugin_manifest_from_single_service_url_with_token() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let server_task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut req_buf = [0u8; 2048];
            let n = socket.read(&mut req_buf).await.unwrap();
            let req_text = String::from_utf8_lossy(&req_buf[..n]);
            assert!(req_text.contains("GET /manifest "));
            assert!(
                req_text.contains("authorization: Bearer demo-qa-token")
                    || req_text.contains("Authorization: Bearer demo-qa-token")
            );

            let body = serde_json::json!({
                "schemaVersion": 1,
                "id": "qa-auto",
                "name": "测试自动发现服务",
                "enabled": true,
                "kind": "http",
                "timeoutMs": 15000,
                "http": {
                    "endpoint": format!("http://{addr}/v1/symbolize"),
                    "healthEndpoint": format!("http://{addr}/health"),
                    "headers": {}
                },
                "serviceInfo": {
                    "availableBuilds": 5,
                    "symbolCount": 10,
                    "recentBuilds": [
                        { "jobId": "job-5", "appVersion": "6.2.19+60384", "flavor": "dev", "target": "ipa" }
                    ],
                    "message": "连接正常"
                }
            })
            .to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });

        let preview = fetch_plugin_from_url(&format!("{addr}?token=demo-qa-token"), None)
            .await
            .unwrap();
        server_task.await.unwrap();

        assert_eq!(preview.plugin.id, "qa-auto");
        assert!(preview.has_secret);
        assert_eq!(
            preview.plugin.http.unwrap().token.as_deref(),
            Some("demo-qa-token")
        );
        assert_eq!(preview.service_info.unwrap().available_builds, Some(5));
    }
}
