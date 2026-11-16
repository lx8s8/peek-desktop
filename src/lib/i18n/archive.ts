export const archiveZh = {
  recoveryTitle: "工作区恢复",
  enableRecovery: "启用自动恢复快照",
  recoveryHint:
    "开启后每 5 秒检查变化，退出时补存。快照保存当前保留的网络、已加载正文和日志；恢复为离线会话，监听需手动启动。",
  pendingRecovery: "有上次工作区可恢复；为避免覆盖，快照写入暂时停止。",
  recoveryReady: "恢复快照已保存；下次启动时可恢复。",
  restoreWorkspace: "恢复上次工作区",
  startNewRecovery: "开始新的恢复记录",
  saveRecovery: "立即保存工作区快照",
  recoveryRestored: "已恢复为离线会话。",
  recoveryBackup: "最新快照损坏，已使用上一份有效快照。",
  recoveryInfo: "恢复缓存 {{size}} · 最近保存 {{time}}",
  recoveryNotSaved: "尚未保存恢复快照",
  recoveryPending: "请先恢复上次工作区，或选择开始新的恢复记录。",
  recoveryNotPending: "本次启动没有待恢复工作区，或已经处理。",
  recoveryCorrupt: "两份恢复快照均无法校验；当前工作区未改动。",
  recoveryUnavailable: "无法访问恢复缓存目录，请检查磁盘空间与文件权限。",
  recoveryInUse: "另一实例正在使用恢复缓存；本实例的自动恢复暂不可用。",
  recoverySettingsInvalid: "恢复配置损坏；自动保存已关闭，可重新设置。",
  nothingToRecover: "当前没有可保存的会话。",
  fileTools: "导出与恢复",
  exportHar: "导出当前网络 HAR…",
  exportAllLogs: "导出当前全部日志 JSONL…",
  exportLogText: "导出当前日志文本…",
  copyCurl: "复制当前请求 cURL",
  exportBounds:
    "导出当前会话的保留数据，不受搜索和时间筛选影响。HAR 保留正文缺失/截断标记；JSONL 可重新导入，文本用于阅读。",
  curlCopied: "已复制 POSIX shell cURL 命令。",
  curlUnsupported:
    "当前请求正文未完整采集，或包含二进制、上传文件等不支持的内容，无法生成完整 cURL。",
  invalidExport: "不支持的导出格式。",
  archiveSession: "保存完整归档…",
  archivedSession: "离线归档",
  recoveredSession: "恢复的离线会话",
  archiveLoss: "设备丢弃 {{dropped}} · 桌面淘汰 {{evicted}}",
  archiveSyncing: "保存时网络快照尚未同步完成",
  invalidBundle: "归档或日志文件损坏，完整校验失败；未导入部分数据。",
  unsupportedBundle: "归档、网络或诊断版本不受支持。",
  bundleTooLarge:
    "归档超过容量限制（展开 256 MiB，12 个网络会话、8 个诊断运行）。",
  bundleWriteFailed: "归档写入失败，原文件保持不变。",
};
export const archiveEn: Record<keyof typeof archiveZh, string> = {
  recoveryTitle: "Workspace recovery",
  enableRecovery: "Enable automatic recovery snapshots",
  recoveryHint:
    "Checks for changes every 5 seconds and saves on exit. Snapshots retain network data, loaded bodies and logs. Recovery opens offline sessions; start listening manually.",
  pendingRecovery:
    "A previous workspace is available. Snapshot writes are paused to protect it.",
  recoveryReady: "Recovery snapshot saved for the next launch.",
  restoreWorkspace: "Restore previous workspace",
  startNewRecovery: "Start a new recovery record",
  saveRecovery: "Save workspace snapshot now",
  recoveryRestored: "Recovered as offline sessions.",
  recoveryBackup:
    "The latest snapshot was corrupt. Recovered the previous valid snapshot.",
  recoveryInfo: "Recovery cache {{size}} · Last saved {{time}}",
  recoveryNotSaved: "No recovery snapshot saved",
  recoveryPending:
    "Restore the previous workspace or start a new recovery record first.",
  recoveryNotPending:
    "No pending recovery, or recovery was already handled this launch.",
  recoveryCorrupt:
    "Neither snapshot passed validation. The current workspace is unchanged.",
  recoveryUnavailable:
    "Recovery storage unavailable. Check disk space and file permissions.",
  recoveryInUse:
    "Another instance owns the recovery cache. Recovery is unavailable here.",
  recoverySettingsInvalid:
    "Recovery settings are corrupt. Automatic saves are off; configure them again.",
  nothingToRecover: "No sessions to save.",
  fileTools: "Export and recovery",
  exportHar: "Export current network as HAR…",
  exportAllLogs: "Export all current logs as JSONL…",
  exportLogText: "Export current logs as text…",
  copyCurl: "Copy current request as cURL",
  exportBounds:
    "Exports retained session data regardless of search and time filters. HAR marks missing/truncated bodies. JSONL supports reimport; text is for reading.",
  curlCopied: "POSIX shell cURL command copied.",
  curlUnsupported:
    "The request body is incomplete or contains unsupported binary/upload data. A complete cURL cannot be generated.",
  invalidExport: "Unsupported export format.",
  archiveSession: "Save complete archive…",
  archivedSession: "Offline archive",
  recoveredSession: "Recovered offline session",
  archiveLoss: "Device dropped {{dropped}} · Desktop evicted {{evicted}}",
  archiveSyncing: "Network snapshot was still syncing when saved",
  invalidBundle:
    "Archive or log validation failed. No partial data was imported.",
  unsupportedBundle: "Unsupported archive, network, or diagnostic version.",
  bundleTooLarge:
    "Archive limit exceeded: 256 MiB expanded, 12 networks, 8 diagnostic runs.",
  bundleWriteFailed: "Archive write failed. The previous file is unchanged.",
};
