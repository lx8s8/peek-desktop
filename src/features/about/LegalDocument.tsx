import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { legalPages, parseNotices } from "./notices";

export function LegalDocument({ text }: { text: string }) {
  const { t } = useTranslation();
  const pages = useMemo(() => legalPages(text), [text]);
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [text]);
  const current = Math.min(page, pages.length - 1);
  return (
    <div className="legal-document">
      {pages.length > 1 && (
        <div className="legal-pagination">
          <Button
            variant="ghost"
            disabled={current === 0}
            onClick={() => setPage((value) => value - 1)}
          >
            {t("previousLegalPage")}
          </Button>
          <output>
            {current + 1} / {pages.length}
          </output>
          <Button
            variant="ghost"
            disabled={current === pages.length - 1}
            onClick={() => setPage((value) => value + 1)}
          >
            {t("nextLegalPage")}
          </Button>
        </div>
      )}
      <pre className="legal-text" data-select-scope="legal-text" tabIndex={0}>
        {pages[current]}
      </pre>
    </div>
  );
}
export function ThirdPartyNotices({ text }: { text: string }) {
  const { t } = useTranslation();
  const { components, documents } = useMemo(() => parseNotices(text), [text]);
  const [query, setQuery] = useState("");
  const [choice, setChoice] = useState("");
  const [document, setDocument] = useState(0);
  const filtered = components.filter((item) =>
    `${item.name} ${item.license} ${item.authors}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  const selected = filtered.find((item) => item.name === choice) ?? filtered[0];
  if (
    !components.length ||
    components.some((item) => item.documents.some((id) => !documents.has(id)))
  )
    return <LegalDocument text={text} />;
  const ids = selected?.documents ?? [];
  return (
    <div className="notices-view">
      <div className="notices-controls">
        <input
          type="search"
          maxLength={256}
          aria-label={t("filterComponents")}
          placeholder={t("filterComponents")}
          value={query}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="none"
          onChange={(event) => {
            setQuery(event.target.value);
            setDocument(0);
          }}
        />
        <select
          aria-label={t("component")}
          value={selected?.name ?? ""}
          onChange={(event) => {
            setChoice(event.target.value);
            setDocument(0);
          }}
        >
          {filtered.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name}
            </option>
          ))}
        </select>
        <small>{t("componentCount", { count: filtered.length })}</small>
      </div>
      {selected ? (
        <>
          <dl className="notice-metadata">
            <div>
              <dt>{t("licenseAgreement")}</dt>
              <dd>{selected.license}</dd>
            </div>
            {selected.authors && (
              <div>
                <dt>{t("upstreamAuthors")}</dt>
                <dd>{selected.authors}</dd>
              </div>
            )}
            <div>
              <dt>{t("source")}</dt>
              <dd>{selected.source}</dd>
            </div>
          </dl>
          {ids.length > 1 && (
            <div
              className="segmented license-choices"
              role="group"
              aria-label={t("licenseAgreement")}
            >
              {ids.map((id, index) => (
                <button
                  key={id}
                  className={document === index ? "active" : ""}
                  onClick={() => setDocument(index)}
                >
                  {t("licenseNumber", { number: index + 1 })}
                </button>
              ))}
            </div>
          )}
          {documents.get(ids[document] ?? ids[0]) ? (
            <LegalDocument
              key={`${selected.name}:${document}`}
              text={documents.get(ids[document] ?? ids[0])!}
            />
          ) : (
            <p className="inline-note">{t("licenseMetadataOnly")}</p>
          )}
        </>
      ) : (
        <p className="inline-note">{t("noComponents")}</p>
      )}
    </div>
  );
}
