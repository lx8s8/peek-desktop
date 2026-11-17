import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BodyView } from "../../lib/ipc/types";
import { JsonViewer } from "./JsonViewer";

export function BodyPreview({
  body,
  theme,
}: {
  body: BodyView;
  theme: string;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState(body.image ? "image" : "text");
  const [fit, setFit] = useState(true);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setMode(body.image ? "image" : "text");
    setFit(true);
    setFailed(false);
  }, [body.image?.dataUrl, body.text]);
  const showImage = mode === "image" && body.image && !failed;
  return (
    <div className="body-preview">
      {body.image && (
        <div className="viewer-toolbar">
          <div className="segmented" role="group" aria-label={t("body")}>
            <button
              className={showImage ? "active" : ""}
              disabled={failed}
              onClick={() => setMode("image")}
            >
              {t("imagePreview")}
            </button>
            <button
              className={!showImage ? "active" : ""}
              onClick={() => setMode("text")}
            >
              {t("hexPreview")}
            </button>
          </div>
          {showImage && (
            <div
              className="segmented"
              role="group"
              aria-label={t("imageScale")}
            >
              <button
                className={fit ? "active" : ""}
                onClick={() => setFit(true)}
              >
                {t("fitImage")}
              </button>
              <button
                className={!fit ? "active" : ""}
                onClick={() => setFit(false)}
              >
                {t("actualImageSize")}
              </button>
            </div>
          )}
        </div>
      )}
      {(body.imageUnavailable || failed) && (
        <div className="inline-note">
          {t(failed ? "imageInvalid" : body.imageUnavailable!)}
        </div>
      )}
      {showImage ? (
        <>
          <div className="image-info">
            {body.image!.mediaType} · {body.image!.width} × {body.image!.height}{" "}
            px
          </div>
          <div
            className={`image-preview-content ${fit ? "image-fit" : "image-actual"}`}
          >
            <img
              src={body.image!.dataUrl}
              alt={t("capturedImage")}
              decoding="async"
              width={body.image!.width}
              height={body.image!.height}
              onError={() => {
                setFailed(true);
                setMode("text");
              }}
            />
          </div>
        </>
      ) : (
        <>
          {body.kind === "bytes" && (
            <div className="inline-note">
              {t("binary")}
              {body.image && body.previewTruncated
                ? ` · ${t("previewTruncated")}`
                : ""}
            </div>
          )}
          <JsonViewer
            text={body.text}
            theme={theme}
            json={
              !body.previewTruncated &&
              (body.kind === "form" ||
                (body.kind === "text" &&
                  (/json/i.test(body.mediaType ?? "") ||
                    /^[\s]*[\[{]/.test(body.text))))
            }
          />
        </>
      )}
    </div>
  );
}
