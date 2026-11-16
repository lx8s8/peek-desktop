export const archiveZh = {
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
