import { useEffect, useId, useRef, useState } from "react";
import { Bookmark, EyeOff, Plus, ShieldAlert, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import type { BizErrorRule } from "../../lib/ipc/types";
import type {
  GlobalNoiseConfig,
  NetworkFilterPreset,
} from "../../lib/preferences";

export interface NetworkRulesDialogProps {
  bizErrorRule: BizErrorRule;
  noiseConfig: GlobalNoiseConfig;
  currentDeviceId?: string;
  currentDeviceLabel?: string;
  presets: NetworkFilterPreset[];
  onSaveBizErrorRule: (rule: BizErrorRule) => void;
  onSaveNoiseConfig: (config: GlobalNoiseConfig) => void;
  onApplyPreset: (preset: NetworkFilterPreset) => void;
  onSaveCurrentAsPreset: (name: string) => void;
  onDeletePreset: (id: string) => void;
  onClose: () => void;
}

/** 持久化降噪屏蔽、HTTP 200 业务错误码识别与自定义筛选预设弹窗（基于原生 modal dialog）。 */
export function NetworkRulesDialog({
  bizErrorRule,
  noiseConfig,
  currentDeviceId,
  currentDeviceLabel,
  presets,
  onSaveBizErrorRule,
  onSaveNoiseConfig,
  onApplyPreset,
  onSaveCurrentAsPreset,
  onDeletePreset,
  onClose,
}: NetworkRulesDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<"biz" | "noise" | "presets">("biz");

  // 业务错误规则编辑态
  const [bizEnabled, setBizEnabled] = useState(bizErrorRule.enabled);
  const [codeField, setCodeField] = useState(bizErrorRule.codeField);
  const [okValuesText, setOkValuesText] = useState(
    bizErrorRule.okValues.join(", "),
  );
  const [successField, setSuccessField] = useState(
    bizErrorRule.successField ?? "",
  );
  const [messageField, setMessageField] = useState(
    bizErrorRule.messageField ?? "",
  );

  // 降噪规则输入态
  const [globalPattern, setGlobalPattern] = useState("");
  const [devicePattern, setDevicePattern] = useState("");
  const [presetName, setPresetName] = useState("");

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (typeof el.showModal === "function") {
      if (!el.open) el.showModal();
    } else {
      el.setAttribute("open", "");
    }
    const handleClose = () => {
      el.returnValue = "";
      onClose();
    };
    el.addEventListener("close", handleClose);

    // 针对不支持 closedby="any" 的 WebKit/Safari 提供指针坐标外点关闭回退
    let pressedOutside = false;
    const isOutside = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      );
    };
    const onPointerDown = (e: PointerEvent) => {
      pressedOutside = isOutside(e);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (pressedOutside && isOutside(e)) {
        if (typeof el.close === "function") el.close();
        else onClose();
      }
      pressedOutside = false;
    };
    const supportsClosedBy =
      typeof HTMLDialogElement !== "undefined" &&
      "closedBy" in HTMLDialogElement.prototype;
    if (!supportsClosedBy) {
      el.addEventListener("pointerdown", onPointerDown);
      el.addEventListener("pointerup", onPointerUp);
    }

    return () => {
      el.removeEventListener("close", handleClose);
      if (!supportsClosedBy) {
        el.removeEventListener("pointerdown", onPointerDown);
        el.removeEventListener("pointerup", onPointerUp);
      }
    };
  }, [onClose]);

  const closeDialog = () => {
    const el = dialogRef.current;
    if (el && typeof el.close === "function" && el.open) {
      el.close();
    } else {
      onClose();
    }
  };

  const commitBizRule = (nextEnabled = bizEnabled) => {
    const okValues = okValuesText
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    onSaveBizErrorRule({
      enabled: nextEnabled,
      codeField: codeField.trim() || "code,errCode,errno",
      okValues: okValues.length > 0 ? okValues : ["0", "200"],
      successField: successField.trim() || null,
      messageField: messageField.trim() || null,
    });
  };

  const addGlobalExclude = () => {
    const cleaned = globalPattern.trim();
    if (!cleaned) return;
    if (
      noiseConfig.globalExcludes.some(
        (p) => p.toLowerCase() === cleaned.toLowerCase(),
      )
    ) {
      setGlobalPattern("");
      return;
    }
    onSaveNoiseConfig({
      ...noiseConfig,
      globalExcludes: [...noiseConfig.globalExcludes, cleaned],
    });
    setGlobalPattern("");
  };

  const removeGlobalExclude = (pattern: string) => {
    onSaveNoiseConfig({
      ...noiseConfig,
      globalExcludes: noiseConfig.globalExcludes.filter((p) => p !== pattern),
    });
  };

  const currentDevicePatterns = currentDeviceId
    ? (noiseConfig.deviceExcludes[currentDeviceId] ?? [])
    : [];

  const addDeviceExclude = () => {
    if (!currentDeviceId) return;
    const cleaned = devicePattern.trim();
    if (!cleaned) return;
    if (
      currentDevicePatterns.some(
        (p) => p.toLowerCase() === cleaned.toLowerCase(),
      )
    ) {
      setDevicePattern("");
      return;
    }
    onSaveNoiseConfig({
      ...noiseConfig,
      deviceExcludes: {
        ...noiseConfig.deviceExcludes,
        [currentDeviceId]: [...currentDevicePatterns, cleaned],
      },
    });
    setDevicePattern("");
  };

  const removeDeviceExclude = (pattern: string) => {
    if (!currentDeviceId) return;
    const nextList = currentDevicePatterns.filter((p) => p !== pattern);
    const nextMap = { ...noiseConfig.deviceExcludes };
    if (nextList.length > 0) nextMap[currentDeviceId] = nextList;
    else delete nextMap[currentDeviceId];
    onSaveNoiseConfig({
      ...noiseConfig,
      deviceExcludes: nextMap,
    });
  };

  return (
    <dialog
      ref={dialogRef}
      className="native-modal-dialog rules-dialog"
      aria-labelledby={titleId}
      {...({ closedby: "any" } as Record<string, string>)}
    >
      <header className="native-modal-head">
        <h1 id={titleId}>{t("networkRulesTitle")}</h1>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("dismiss")}
          onClick={closeDialog}
        >
          <X aria-hidden="true" />
        </Button>
      </header>

      <div className="rules-tabs segmented" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "biz"}
          className={tab === "biz" ? "active" : ""}
          onClick={() => setTab("biz")}
        >
          <ShieldAlert size={12} aria-hidden="true" />
          {t("bizErrorRuleTab")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "noise"}
          className={tab === "noise" ? "active" : ""}
          onClick={() => setTab("noise")}
        >
          <EyeOff size={12} aria-hidden="true" />
          {t("noiseRulesTab")} ({noiseConfig.globalExcludes.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "presets"}
          className={tab === "presets" ? "active" : ""}
          onClick={() => setTab("presets")}
        >
          <Bookmark size={12} aria-hidden="true" />
          {t("filterPresetsTab")} ({presets.length})
        </button>
      </div>

      <div className="rules-body">
        {tab === "biz" && (
          <div className="rules-section">
            <label className="checkbox-label">
              <input
                type="checkbox"
                autoFocus
                checked={bizEnabled}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setBizEnabled(checked);
                  commitBizRule(checked);
                }}
              />
              {t("bizErrorEnable")}
            </label>
            <p className="muted">{t("bizErrorHint")}</p>
            <div className="rules-form-grid">
              <label>
                {t("bizErrorCodeField")}
                <input
                  type="text"
                  value={codeField}
                  placeholder="code,errCode,errno,meta.code"
                  onChange={(e) => setCodeField(e.target.value)}
                />
              </label>
              <label>
                {t("bizErrorOkValues")}
                <input
                  type="text"
                  value={okValuesText}
                  placeholder="0, 200, OK"
                  onChange={(e) => setOkValuesText(e.target.value)}
                />
              </label>
              <label>
                {t("bizErrorSuccessField")}
                <input
                  type="text"
                  value={successField}
                  placeholder="success,ok"
                  onChange={(e) => setSuccessField(e.target.value)}
                />
              </label>
              <label>
                {t("bizErrorMessageField")}
                <input
                  type="text"
                  value={messageField}
                  placeholder="msg,message,error"
                  onChange={(e) => setMessageField(e.target.value)}
                />
              </label>
            </div>
            <div className="rules-footer-actions">
              <Button variant="primary" onClick={() => commitBizRule()}>
                {t("bizErrorApply")}
              </Button>
            </div>
          </div>
        )}

        {tab === "noise" && (
          <div className="rules-section">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={noiseConfig.enabled}
                onChange={(e) =>
                  onSaveNoiseConfig({
                    ...noiseConfig,
                    enabled: e.target.checked,
                  })
                }
              />
              {t("noiseRulesEnable")}
            </label>
            <p className="muted">{t("noiseRulesHint")}</p>

            <h3>{t("noiseGlobalTitle")}</h3>
            <div className="rules-add-row">
              <input
                type="text"
                value={globalPattern}
                placeholder={t("noisePatternPlaceholder")}
                aria-label={t("noiseGlobalTitle")}
                onChange={(e) => setGlobalPattern(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addGlobalExclude();
                  }
                }}
              />
              <Button onClick={addGlobalExclude}>
                <Plus size={12} aria-hidden="true" />
                {t("noiseAddPattern")}
              </Button>
            </div>
            <div className="rules-chip-list">
              {noiseConfig.globalExcludes.length === 0 ? (
                <span className="muted">{t("noiseEmptyHint")}</span>
              ) : (
                noiseConfig.globalExcludes.map((pattern) => (
                  <button
                    key={pattern}
                    type="button"
                    className="host-chip is-exclude"
                    onClick={() => removeGlobalExclude(pattern)}
                  >
                    -{pattern} ×
                  </button>
                ))
              )}
            </div>

            {currentDeviceId && (
              <>
                <h3>
                  {t("noiseDeviceTitle", {
                    device: currentDeviceLabel || currentDeviceId,
                  })}
                </h3>
                <div className="rules-add-row">
                  <input
                    type="text"
                    value={devicePattern}
                    placeholder={t("noisePatternPlaceholder")}
                    aria-label={t("noiseDeviceTitle", {
                      device: currentDeviceLabel || currentDeviceId,
                    })}
                    onChange={(e) => setDevicePattern(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addDeviceExclude();
                      }
                    }}
                  />
                  <Button onClick={addDeviceExclude}>
                    <Plus size={12} aria-hidden="true" />
                    {t("noiseAddPattern")}
                  </Button>
                </div>
                <div className="rules-chip-list">
                  {currentDevicePatterns.length === 0 ? (
                    <span className="muted">{t("noiseEmptyHint")}</span>
                  ) : (
                    currentDevicePatterns.map((pattern) => (
                      <button
                        key={pattern}
                        type="button"
                        className="host-chip is-exclude"
                        onClick={() => removeDeviceExclude(pattern)}
                      >
                        -{pattern} ×
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {tab === "presets" && (
          <div className="rules-section">
            <p className="muted">{t("filterPresetsHint")}</p>
            <div className="rules-add-row">
              <input
                type="text"
                value={presetName}
                placeholder={t("filterPresetNamePlaceholder")}
                aria-label={t("filterPresetNamePlaceholder")}
                onChange={(e) => setPresetName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && presetName.trim()) {
                    e.preventDefault();
                    onSaveCurrentAsPreset(presetName.trim());
                    setPresetName("");
                  }
                }}
              />
              <Button
                variant="primary"
                disabled={!presetName.trim()}
                onClick={() => {
                  if (!presetName.trim()) return;
                  onSaveCurrentAsPreset(presetName.trim());
                  setPresetName("");
                }}
              >
                <Plus size={12} aria-hidden="true" />
                {t("filterPresetSaveCurrent")}
              </Button>
            </div>
            <ul className="rules-preset-list">
              {presets.length === 0 ? (
                <li className="muted">{t("filterPresetsEmpty")}</li>
              ) : (
                presets.map((preset) => (
                  <li key={preset.id} className="rules-preset-row">
                    <button
                      type="button"
                      className="rules-preset-apply"
                      onClick={() => {
                        onApplyPreset(preset);
                        closeDialog();
                      }}
                    >
                      <strong>{preset.name}</strong>
                      <small className="muted">
                        {[
                          preset.filter !== "all" ? t(preset.filter) : "",
                          preset.methodFilter ?? "",
                          preset.statusFilter ?? "",
                          preset.minDurationMs
                            ? `>=${preset.minDurationMs}ms`
                            : "",
                          preset.search ? `"${preset.search}"` : "",
                        ]
                          .filter(Boolean)
                          .join(" · ") || t("all")}
                      </small>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${t("filterPresetDelete")} ${preset.name}`}
                      onClick={() => onDeletePreset(preset.id)}
                    >
                      <Trash2 size={12} aria-hidden="true" />
                    </Button>
                  </li>
                ))
              )}
            </ul>
          </div>
        )}
      </div>
    </dialog>
  );
}
