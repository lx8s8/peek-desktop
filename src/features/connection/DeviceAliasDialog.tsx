import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Pencil, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";

/**
 * 桌面端设备备注 / 自定义名称编辑弹窗：
 * 通过 Portal 挂载到 document.body，按 deviceId 本地持久化备注名并保留设备原上报机型。
 */
export function DeviceAliasDialog({
  deviceId,
  reportedName,
  initialAlias,
  onSave,
  onClose,
}: {
  deviceId: string;
  reportedName: string;
  initialAlias: string;
  onSave: (deviceId: string, alias: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initialAlias);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    onSave(deviceId, value);
    onClose();
  }

  return createPortal(
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="alias-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("deviceAliasTitle")}
      >
        <header className="replay-header">
          <div className="diff-title-row">
            <Pencil size={15} />
            <h2>{t("deviceAliasTitle")}</h2>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("dismiss")}
            onClick={onClose}
          >
            <X />
          </Button>
        </header>
        <form className="alias-form" onSubmit={handleSubmit}>
          <p className="muted small">{t("deviceAliasHint")}</p>
          <div className="alias-reported-row">
            <span className="muted">{t("deviceAliasReported")}</span>
            <code>{reportedName}</code>
          </div>
          <input
            autoFocus
            maxLength={60}
            value={value}
            placeholder={t("deviceAliasPlaceholder")}
            onChange={(event) => setValue(event.target.value)}
          />
          <div className="alias-actions">
            {initialAlias && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  onSave(deviceId, "");
                  onClose();
                }}
              >
                {t("deviceAliasReset")}
              </Button>
            )}
            <div className="alias-actions-right">
              <Button type="button" variant="ghost" onClick={onClose}>
                {t("dismiss")}
              </Button>
              <Button type="submit" variant="primary">
                {t("deviceAliasSave")}
              </Button>
            </div>
          </div>
        </form>
      </section>
    </div>,
    document.body,
  );
}
