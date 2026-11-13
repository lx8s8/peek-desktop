import { useEffect, useState } from "react";
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
  useEffect(() => {
    setFrom(localInput(range.from));
    setTo(localInput(range.to));
  }, [range.from, range.to]);
  const invalid = !!(
    from &&
    to &&
    new Date(from).getTime() > new Date(to).getTime()
  );
  return (
    <details className="time-range">
      <summary>
        {t("timeRange")} ·{" "}
        {range.from || range.to
          ? `${range.from ? new Date(range.from).toLocaleString(i18n.language) : "…"} – ${range.to ? new Date(range.to).toLocaleString(i18n.language) : "…"}`
          : t("resetRange")}
      </summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!invalid)
            onChange({
              from: from ? new Date(from).toISOString() : null,
              to: to ? new Date(to).toISOString() : null,
            });
        }}
      >
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
        <Button type="submit" disabled={invalid}>
          {t("applyRange")}
        </Button>
        <Button type="button" onClick={() => onChange({})}>
          {t("resetRange")}
        </Button>
        {invalid && <span role="alert">{t("invalidTimeRange")}</span>}
      </form>
    </details>
  );
}
