import { useEffect, useId, useMemo, useState, type MouseEvent } from "react";
import {
  Activity,
  ChevronRight,
  Ellipsis,
  FileCode2,
  FileStack,
  FolderOpen,
  Monitor,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import type {
  DiagnosticRun,
  RemoteSnapshot,
  SessionSummary,
} from "../../lib/ipc/types";
import { resolveDeviceDisplay } from "../../lib/preferences";
import {
  formatRunStartedAt,
  formatRunStartedAtFull,
  groupWorkspaceSessions,
  type DeviceSessionGroup,
} from "./sessionGroups";

export interface SessionSidebarProps {
  sessions: SessionSummary[];
  remote: RemoteSnapshot;
  activeId: string | null;
  independentId: string | null;
  deviceAliases: Record<string, string>;
  desktop: boolean;
  busy: boolean;
  saving: boolean;
  onSelectSession: (sessionId: string) => void;
  onSelectIndependent: (runId: string) => void;
  onOpenFile: () => void;
  onCloseSession: (sessionId: string) => void;
  onCloseDeviceOfflineRuns: (
    deviceId: string,
    deviceDisplayName: string,
  ) => void;
  onCloseDiagnostic: (runId: string) => void;
  onEditDeviceAlias: (deviceId: string, reportedName: string) => void;
  onSessionContextMenu: (
    sessionId: string,
    event: MouseEvent<HTMLElement>,
  ) => void;
  onIndependentContextMenu: (
    runId: string,
    event: MouseEvent<HTMLElement>,
  ) => void;
}

/** 侧边栏会话导航：实时设备按 deviceId 聚合展示历次运行，离线文件与独立诊断分栏呈现。 */
export function SessionSidebar({
  sessions,
  remote,
  activeId,
  independentId,
  deviceAliases,
  desktop,
  busy,
  saving,
  onSelectSession,
  onSelectIndependent,
  onOpenFile,
  onCloseSession,
  onCloseDeviceOfflineRuns,
  onCloseDiagnostic,
  onEditDeviceAlias,
  onSessionContextMenu,
  onIndependentContextMenu,
}: SessionSidebarProps) {
  const { t, i18n } = useTranslation();
  const baseId = useId();
  // 仅记录用户手动折叠的设备 ID，默认所有多运行设备组处于展开状态
  const [collapsedDevices, setCollapsedDevices] = useState<
    Record<string, boolean>
  >({});

  const { deviceGroups, fileSessions } = useMemo(
    () => groupWorkspaceSessions(sessions, remote.pairing?.devices ?? []),
    [sessions, remote.pairing?.devices],
  );

  // 若某个多运行设备组仅剩 1 条运行或已消失，清理陈旧的折叠标记，确保之后再次重连产生多条时默认展开
  useEffect(() => {
    setCollapsedDevices((previous) => {
      const multiIds = new Set(
        deviceGroups
          .filter((group) => group.runs.length > 1)
          .map((group) => group.deviceId),
      );
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const [id, value] of Object.entries(previous)) {
        if (value && multiIds.has(id)) {
          next[id] = true;
        } else {
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [deviceGroups]);

  // 当通过自动切新或外部操作激活了某个已折叠设备内的运行时，自动展开该设备组
  useEffect(() => {
    if (!activeId || independentId) return;
    const owner = deviceGroups.find(
      (group) =>
        group.runs.length > 1 && group.runs.some((run) => run.id === activeId),
    );
    if (!owner) return;
    setCollapsedDevices((previous) => {
      if (!previous[owner.deviceId]) return previous;
      const next = { ...previous };
      delete next[owner.deviceId];
      return next;
    });
  }, [activeId, independentId, deviceGroups]);

  const onlineDeviceCount = useMemo(() => {
    const ids = new Set<string>();
    for (const group of deviceGroups) {
      if (group.hasOnline) ids.add(group.deviceId);
    }
    for (const session of remote.sessions) {
      if (session.online && session.deviceId) ids.add(session.deviceId);
    }
    return ids.size;
  }, [deviceGroups, remote.sessions]);

  const independentRuns = useMemo<DiagnosticRun[]>(
    () =>
      remote.diagnosticRuns.filter(
        (run) =>
          !run.networkSessionKey ||
          !sessions.some((session) => session.id === run.networkSessionKey),
      ),
    [remote.diagnosticRuns, sessions],
  );

  const toggleDeviceGroup = (deviceId: string) => {
    setCollapsedDevices((previous) => ({
      ...previous,
      [deviceId]: !previous[deviceId],
    }));
  };

  const formatStatusText = (session: SessionSummary) =>
    t(
      session.syncing
        ? "syncing"
        : session.online
          ? "connected"
          : "disconnected",
    );

  const formatDiagnosticsText = (session: SessionSummary) =>
    t(
      session.diagnosticsOnline
        ? "diagnosticsLive"
        : session.diagnosticCount
          ? "diagnosticsRetained"
          : "diagnosticsNotConnected",
    );

  const renderDeviceGroupSummary = (group: DeviceSessionGroup) => {
    if (group.onlineCount > 0 && group.offlineCount > 0) {
      return t("deviceRunsSummaryOnline", {
        online: group.onlineCount,
        offline: group.offlineCount,
      });
    }
    if (group.onlineCount > 0) {
      return t("deviceRunsSummaryAllOnline", { count: group.onlineCount });
    }
    return t("deviceRunsSummaryAllOffline", { count: group.offlineCount });
  };

  return (
    <nav className="sidebar" aria-label={t("sessions")}>
      <div className="sidebar-heading">
        {t("sessions")}
        <span>{sessions.length}</span>
      </div>

      <div className="sidebar-section-title">
        <Monitor size={13} aria-hidden="true" />
        <span>{t("liveDevices")}</span>
        <span className="sidebar-status-pill">
          <span
            className={`live-dot ${onlineDeviceCount > 0 ? "is-online" : ""}`}
            aria-hidden="true"
          />
          {onlineDeviceCount > 0
            ? t("onlineDeviceCount", { count: onlineDeviceCount })
            : t("noConnectedDevice")}
        </span>
      </div>

      <div className="sidebar-scroll">
        {deviceGroups.length > 0 ? (
          <ul className="session-list device-group-list">
            {deviceGroups.map((group, groupIndex) => {
              const display = resolveDeviceDisplay(
                group.deviceId,
                group.reportedName,
                deviceAliases,
              );

              // 单次运行：呈现为紧凑的设备运行项，不增加额外层级
              if (group.runs.length === 1) {
                const session = group.runs[0];
                const isActive = !independentId && session.id === activeId;
                const timeText = formatRunStartedAt(
                  session.header.startedAt,
                  i18n.language,
                );
                const fullTime = formatRunStartedAtFull(
                  session.header.startedAt,
                  i18n.language,
                );
                return (
                  <li
                    key={group.deviceId}
                    onContextMenu={(event) =>
                      onSessionContextMenu(session.id, event)
                    }
                    className={`session-item ${isActive ? "active" : ""}`}
                  >
                    <button
                      type="button"
                      className="session-select"
                      onClick={() => onSelectSession(session.id)}
                      aria-current={isActive ? "true" : undefined}
                      title={
                        fullTime
                          ? `${display.title} · ${t("runStartedAt", { time: fullTime })}`
                          : display.title
                      }
                    >
                      <span className="session-icon-badge" aria-hidden="true">
                        <Monitor size={15} />
                        <span
                          className={`live-dot ${session.online ? "is-online" : ""}`}
                        />
                      </span>
                      <span>
                        <strong>{display.title}</strong>
                        {display.subtitle && (
                          <small
                            className="session-alias-origin"
                            title={display.subtitle}
                          >
                            {display.subtitle}
                          </small>
                        )}
                        <small>
                          {formatStatusText(session)}
                          {timeText ? ` · ${timeText}` : ""} ·{" "}
                          {session.entryCount.toLocaleString()} {t("requests")}{" "}
                          · {formatDiagnosticsText(session)}
                        </small>
                      </span>
                    </button>
                    <div className="session-item-actions">
                      <Button
                        variant="ghost"
                        size="icon"
                        title={t("deviceAliasTitle")}
                        aria-label={`${t("deviceAliasTitle")} ${display.title}`}
                        onClick={() =>
                          onEditDeviceAlias(group.deviceId, group.reportedName)
                        }
                      >
                        <Pencil size={12} aria-hidden="true" />
                      </Button>
                      {desktop && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-haspopup="menu"
                          aria-label={`${t("menuActions")} ${display.title}`}
                          onClick={(event) =>
                            onSessionContextMenu(session.id, event)
                          }
                        >
                          <Ellipsis aria-hidden="true" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`${t("close")} ${display.title}`}
                        disabled={session.online || busy || saving}
                        onClick={() => onCloseSession(session.id)}
                      >
                        <X aria-hidden="true" />
                      </Button>
                    </div>
                  </li>
                );
              }

              // 多次运行：按设备聚合为可展开/折叠的分组卡片
              const expanded = !collapsedDevices[group.deviceId];
              const runsListId = `${baseId}-device-runs-${groupIndex}`;
              const hasActiveRun =
                !independentId && group.runs.some((run) => run.id === activeId);

              return (
                <li
                  key={group.deviceId}
                  className={`device-group ${hasActiveRun ? "has-active" : ""} ${expanded ? "is-expanded" : "is-collapsed"}`}
                >
                  <div className="device-group-header">
                    <button
                      type="button"
                      className="device-group-toggle"
                      aria-expanded={expanded}
                      aria-controls={runsListId}
                      title={t(
                        expanded ? "collapseDeviceRuns" : "expandDeviceRuns",
                        { name: display.title },
                      )}
                      onClick={() => toggleDeviceGroup(group.deviceId)}
                    >
                      <ChevronRight
                        size={13}
                        className="device-group-chevron"
                        aria-hidden="true"
                      />
                      <span
                        className={`live-dot ${group.hasOnline ? "is-online" : ""}`}
                        aria-hidden="true"
                      />
                      <span className="device-group-meta">
                        <span className="device-group-title-row">
                          <strong title={display.title}>{display.title}</strong>
                          <span className="device-run-count">
                            {t("deviceRunCount", { count: group.runs.length })}
                          </span>
                        </span>
                        {display.subtitle && (
                          <small
                            className="session-alias-origin"
                            title={display.subtitle}
                          >
                            {display.subtitle}
                          </small>
                        )}
                        <small className="device-group-summary">
                          {renderDeviceGroupSummary(group)}
                        </small>
                      </span>
                    </button>
                    <div className="device-group-actions">
                      <Button
                        variant="ghost"
                        size="icon"
                        title={t("deviceAliasTitle")}
                        aria-label={`${t("deviceAliasTitle")} ${display.title}`}
                        onClick={() =>
                          onEditDeviceAlias(group.deviceId, group.reportedName)
                        }
                      >
                        <Pencil size={12} aria-hidden="true" />
                      </Button>
                      {group.offlineCount > 0 && (
                        <Button
                          variant="ghost"
                          size="icon"
                          title={t("clearDeviceOfflineRunsLabel", {
                            name: display.title,
                            count: group.offlineCount,
                          })}
                          aria-label={t("clearDeviceOfflineRunsLabel", {
                            name: display.title,
                            count: group.offlineCount,
                          })}
                          disabled={busy || saving}
                          onClick={() =>
                            onCloseDeviceOfflineRuns(
                              group.deviceId,
                              display.title,
                            )
                          }
                        >
                          <Trash2 size={12} aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                  </div>

                  <ul
                    id={runsListId}
                    className="device-run-list"
                    hidden={!expanded}
                  >
                    {group.runs.map((session, runIndex) => {
                      const isActive =
                        !independentId && session.id === activeId;
                      const runName = session.header.name || session.filename;
                      const timeText = formatRunStartedAt(
                        session.header.startedAt,
                        i18n.language,
                      );
                      const fullTime = formatRunStartedAtFull(
                        session.header.startedAt,
                        i18n.language,
                      );
                      const statusText = formatStatusText(session);
                      const isLatest = runIndex === 0;
                      const runPrimaryLabel = group.hasDistinctRunNames
                        ? runName
                        : timeText || runName;
                      const runCloseLabel = `${t("close")} ${display.title} ${timeText || runName}`;

                      return (
                        <li
                          key={session.id}
                          onContextMenu={(event) =>
                            onSessionContextMenu(session.id, event)
                          }
                          className={`session-item device-run-item ${isActive ? "active" : ""}`}
                        >
                          <button
                            type="button"
                            className="session-select device-run-select"
                            onClick={() => onSelectSession(session.id)}
                            aria-current={isActive ? "true" : undefined}
                            title={
                              fullTime
                                ? `${display.title} · ${t("runStartedAt", { time: fullTime })}`
                                : display.title
                            }
                          >
                            <span
                              className={`live-dot ${session.online ? "is-online" : ""}`}
                              aria-hidden="true"
                            />
                            <span>
                              <span className="device-run-headline">
                                <strong>{runPrimaryLabel}</strong>
                                <span
                                  className={`run-state-tag ${session.online ? "is-online" : ""}`}
                                >
                                  {statusText}
                                </span>
                                {isLatest && !session.online && (
                                  <span className="run-latest-tag">
                                    {t("latestRun")}
                                  </span>
                                )}
                              </span>
                              <small>
                                {group.hasDistinctRunNames && timeText
                                  ? `${timeText} · `
                                  : ""}
                                {session.entryCount.toLocaleString()}{" "}
                                {t("requests")} ·{" "}
                                {formatDiagnosticsText(session)}
                              </small>
                            </span>
                          </button>
                          <div className="session-item-actions">
                            {desktop && (
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-haspopup="menu"
                                aria-label={`${t("menuActions")} ${runPrimaryLabel}`}
                                onClick={(event) =>
                                  onSessionContextMenu(session.id, event)
                                }
                              >
                                <Ellipsis aria-hidden="true" />
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={runCloseLabel}
                              disabled={session.online || busy || saving}
                              onClick={() => onCloseSession(session.id)}
                            >
                              <X aria-hidden="true" />
                            </Button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="device-placeholder">
            <span
              className={`live-dot ${onlineDeviceCount > 0 ? "is-online" : ""}`}
              aria-hidden="true"
            />
            {t("noConnectedDevice")}
          </div>
        )}

        <div className="sidebar-section-title files-title">
          <FileStack size={13} aria-hidden="true" />
          <span>{t("offlineFiles")}</span>
          <Button
            variant="ghost"
            size="icon"
            title={t("open")}
            aria-label={t("open")}
            disabled={!desktop || busy || saving}
            onClick={onOpenFile}
          >
            <FolderOpen aria-hidden="true" />
          </Button>
        </div>

        {fileSessions.length > 0 ? (
          <ul className="session-list">
            {fileSessions.map((session) => {
              const title = session.header.name || session.filename;
              const isActive = !independentId && session.id === activeId;
              return (
                <li
                  key={session.id}
                  onContextMenu={(event) =>
                    onSessionContextMenu(session.id, event)
                  }
                  className={`session-item ${isActive ? "active" : ""}`}
                >
                  <button
                    type="button"
                    className="session-select"
                    onClick={() => onSelectSession(session.id)}
                    aria-current={isActive ? "true" : undefined}
                  >
                    <FileCode2 size={16} aria-hidden="true" />
                    <span>
                      <strong title={title}>{title}</strong>
                      {session.archive && (
                        <small>
                          {t(
                            session.archive.recovered
                              ? "recoveredSession"
                              : "archivedSession",
                          )}
                          {` · ${t("archiveLoss", {
                            dropped: session.archive.dropped,
                            evicted: session.archive.evicted,
                          })}`}
                          {session.archive.syncing
                            ? ` · ${t("archiveSyncing")}`
                            : ""}
                        </small>
                      )}
                      <small>
                        {session.header.platform} ·{" "}
                        {session.entryCount.toLocaleString()} {t("requests")}
                      </small>
                    </span>
                  </button>
                  <div className="session-item-actions">
                    {desktop && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-haspopup="menu"
                        aria-label={`${t("menuActions")} ${title}`}
                        onClick={(event) =>
                          onSessionContextMenu(session.id, event)
                        }
                      >
                        <Ellipsis aria-hidden="true" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${t("close")} ${session.filename}`}
                      disabled={busy || saving}
                      onClick={() => onCloseSession(session.id)}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="no-files">{t("noOpenedFiles")}</div>
        )}

        {independentRuns.length > 0 && (
          <>
            <div className="sidebar-section-title files-title">
              <Activity size={13} aria-hidden="true" />
              <span>{t("independentRuns")}</span>
            </div>
            <ul className="session-list">
              {independentRuns.map((run) => {
                const isActive = independentId === run.id;
                return (
                  <li
                    className={`session-item ${isActive ? "active" : ""}`}
                    key={run.id}
                    onContextMenu={(event) =>
                      onIndependentContextMenu(run.id, event)
                    }
                  >
                    <button
                      type="button"
                      className="session-select"
                      aria-current={isActive ? "true" : undefined}
                      onClick={() => onSelectIndependent(run.id)}
                    >
                      <Activity size={16} aria-hidden="true" />
                      <span>
                        <strong>{run.runId}</strong>
                        <small>
                          {t(run.online ? "connected" : "disconnected")} ·{" "}
                          {run.count}
                        </small>
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${t("close")} ${run.runId}`}
                      disabled={run.online || busy || saving}
                      onClick={() => onCloseDiagnostic(run.id)}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </nav>
  );
}
