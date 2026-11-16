export const archiveZh = {
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
