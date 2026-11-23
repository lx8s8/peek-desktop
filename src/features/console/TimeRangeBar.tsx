import { useEffect, useRef, useState } from "react";
import { Clock, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import type { TimeRange } from "../../lib/ipc/types";

function localInput(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Date(date.getTime() - date.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 23)
    : "";
}

export function TimeRangeBar({
  range,
  onChange,
}: {
  range: TimeRange;
  onChange: (range: TimeRange) => void;
}) {
  const { t, i18n } = useTranslation();
  const [from, setFrom] = useState(localInput(range.from));
  const [to, setTo] = useState(localInput(range.to));
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    setFrom(localInput(range.from));
    setTo(localInput(range.to));
  }, [range.from, range.to]);

  // 点击外部或按 Escape 自动收起时间范围弹层
  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const el = detailsRef.current;
      if (el?.open && !el.contains(event.target as Node)) {
        el.open = false;
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && detailsRef.current?.open) {
        detailsRef.current.open = false;
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const invalid = !!(
    from &&
    to &&
    new Date(from).getTime() > new Date(to).getTime()
  );
  const active = !!(range.from || range.to);

  return (
    <details
      ref={detailsRef}
      className={`time-range ${active ? "is-active" : ""}`}
    >
      <summary title={t("timeRange")}>
        <Clock size={12} />
        <span>
          {active
            ? `${range.from ? new Date(range.from).toLocaleTimeString(i18n.language, { hour12: false }) : "…"} – ${range.to ? new Date(range.to).toLocaleTimeString(i18n.language, { hour12: false }) : "…"}`
            : t("resetRange")}
        </span>
      </summary>
      <form
        className="time-range-panel"
        onSubmit={(event) => {
          event.preventDefault();
          if (!invalid) {
            onChange({
              from: from ? new Date(from).toISOString() : null,
              to: to ? new Date(to).toISOString() : null,
            });
            if (detailsRef.current) detailsRef.current.open = false;
          }
        }}
      >
        <div className="time-range-title">
          <strong>{t("timeRange")}</strong>
          <button
            type="button"
            className="inline-dismiss"
            aria-label={t("dismiss")}
            onClick={() => {
              if (detailsRef.current) detailsRef.current.open = false;
            }}
          >
            <X size={13} />
          </button>
        </div>
        <label>
          {t("fromTime")}
          <input
            type="datetime-local"
            step="0.001"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </label>
        <label>
          {t("toTime")}
          <input
            type="datetime-local"
            step="0.001"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </label>
        <div className="time-range-actions">
          <Button variant="primary" size="sm" type="submit" disabled={invalid}>
            {t("applyRange")}
          </Button>
          <Button
            size="sm"
            type="button"
            onClick={() => {
              onChange({});
              if (detailsRef.current) detailsRef.current.open = false;
            }}
          >
            {t("resetRange")}
          </Button>
        </div>
        {invalid && <span role="alert">{t("invalidTimeRange")}</span>}
      </form>
    </details>
  );
}
