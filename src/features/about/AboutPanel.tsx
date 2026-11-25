import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, Info, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { commands } from "../../lib/commands/dispatcher";
import { useCommand } from "../../lib/commands/react";
import { api, desktop } from "../../lib/ipc/client";
import { LegalDocument, ThirdPartyNotices } from "./LegalDocument";
import { UpdateCheck } from "./UpdateCheck";
import type { AppInfo, ProjectLink } from "../../lib/ipc/types";

export function AboutPanel() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [checkRequest, setCheckRequest] = useState(0);
  const [updating, setUpdating] = useState(false);
  const [view, setView] = useState("info");
  const [legal, setLegal] = useState("");
  const [error, setError] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  useCommand("help.about", () => {
    setView("info");
    setCheckRequest(0);
    setOpen(true);
  });
  useCommand(
    "help.checkUpdates",
    () => {
      setView("info");
      setOpen(true);
      setCheckRequest((value) => value + 1);
    },
    desktop,
  );
  useCommand("help.project", () => api.openProjectLink("project"), desktop);
  useCommand("help.issues", () => api.openProjectLink("issues"), desktop);
  useEffect(() => {
    if (!open || !desktop) return;
    let active = true;
    setError("");
    void api
      .appInfo()
      .then((value) => {
        if (active) setInfo(value);
      })
      .catch(() => {
        if (active) setError("aboutLoadFailed");
      });
    return () => {
      active = false;
    };
  }, [open]);
  useEffect(() => {
    if (!open || view === "info" || !desktop) return;
    let active = true;
    setLegal("");
    setError("");
    void api
      .legalText(view as "license" | "notices")
      .then((value) => {
        if (active) setLegal(value);
      })
      .catch(() => {
        if (active) setError("aboutLoadFailed");
      });
    return () => {
      active = false;
    };
  }, [open, view]);
  useEffect(() => {
    if (!open) return;
    const unblock = commands.block(
      (id) =>
        ![
          "help.about",
          "help.checkUpdates",
          "view.language",
          "view.theme",
          "language.zh-CN",
          "language.en",
        ].includes(id),
    );
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!updating) setOpen(false);
      }
      if (event.key === "Tab") {
        const nodes = dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
        );
        if (!nodes?.length) return;
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", keydown, true);
    return () => {
      unblock();
      window.removeEventListener("keydown", keydown, true);
      trigger.current?.focus();
    };
  }, [open, updating]);
  async function link(value: ProjectLink) {
    try {
      await api.openProjectLink(value);
    } catch {
      setError("openLinkFailed");
    }
  }
  return (
    <>
      <Button
        ref={trigger}
        variant="ghost"
        size="icon"
        aria-label={t("menuAbout")}
        title={t("menuAbout")}
        onClick={() => commands.dispatch("help.about")}
      >
        <Info />
      </Button>
      {open &&
        createPortal(
          <div
            className="dialog-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !updating)
                setOpen(false);
            }}
          >
            <section
              ref={dialog}
              className={`about-dialog ${view === "info" ? "about-info" : ""}`}
              role="dialog"
              aria-modal="true"
              aria-label={t("menuAbout")}
            >
              <header>
                <h2>{t("menuAbout")}</h2>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("dismiss")}
                  disabled={updating}
                  autoFocus
                  onClick={() => setOpen(false)}
                >
                  <X />
                </Button>
              </header>
              <div
                className="segmented about-tabs"
                role="group"
                aria-label={t("aboutSections")}
              >
                {(["info", "license", "notices"] as const).map((value) => (
                  <button
                    key={value}
                    disabled={updating}
                    className={view === value ? "active" : ""}
                    onClick={() => setView(value)}
                  >
                    {t(
                      {
                        info: "aboutDetails",
                        license: "licenseAgreement",
                        notices: "thirdPartyNotices",
                      }[value],
                    )}
                  </button>
                ))}
              </div>
              {error && (
                <p className="inline-note warning" role="alert">
                  {t(error)}
                </p>
              )}
              {view === "info" ? (
                <div className="about-content">
                  <h3>
                    Peek Desktop <span>{info?.version ?? "—"}</span>
                  </h3>
                  <p className="muted">
                    {info
                      ? `${info.platform} · ${info.architecture}`
                      : t(desktop ? "loading" : "browser")}
                  </p>
                  <UpdateCheck
                    request={checkRequest}
                    onCheck={() => setCheckRequest((value) => value + 1)}
                    onBusyChange={setUpdating}
                  />
                  <dl className="about-facts">
                    <div>
                      <dt>{t("author")}</dt>
                      <dd>kasen</dd>
                    </div>
                    <div>
                      <dt>{t("licenseAgreement")}</dt>
                      <dd>MIT</dd>
                    </div>
                  </dl>
                  <div className="about-links">
                    {(
                      [
                        ["project", "projectRepository"],
                        ["issues", "reportIssue"],
                        ["releases", "releaseHistory"],
                        ["sdk", "flutterSdk"],
                        ["upstream", "upstreamProject"],
                      ] as const
                    ).map(([value, label]) => (
                      <Button
                        key={value}
                        variant="ghost"
                        disabled={!desktop}
                        onClick={() => void link(value)}
                      >
                        {t(label)}
                        <ExternalLink size={13} />
                      </Button>
                    ))}
                  </div>
                  <p className="about-project-url">
                    github.com/lx8s8/peek-desktop
                  </p>
                  <p className="muted">Copyright © 2026 kasen</p>
                </div>
              ) : legal ? (
                view === "notices" ? (
                  <ThirdPartyNotices text={legal} />
                ) : (
                  <LegalDocument text={legal} />
                )
              ) : (
                <div className="loading">{t("loading")}</div>
              )}
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
