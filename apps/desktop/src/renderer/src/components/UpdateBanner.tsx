import { useEffect, useState } from "react";
import type { UpdateStatus } from "../../../shared/api.js";
import { t } from "../i18n.js";

/** A newer version (#193): a link to its download, or "Restart to update" once downloaded. Floats above the window. */
export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    void window.frameshell.updates.status().then(setStatus);
    return window.frameshell.updates.onStatus(setStatus);
  }, []);
  if (!status) return null;
  return (
    <div className="update-banner" role="status">
      <p>{status.state === "ready" ? t.app.updates.ready(status.version) : t.app.updates.available(status.version)}</p>
      {status.state === "ready" ? (
        <button className="button primary" onClick={() => window.frameshell.updates.restart()}>
          {t.app.updates.restart}
        </button>
      ) : (
        // Opened in the browser by main's window-open handler.
        <a className="button primary" href={status.url} target="_blank" rel="noreferrer">
          {t.app.updates.download}
        </a>
      )}
      <button className="link" onClick={() => window.frameshell.updates.dismiss()}>
        {t.app.updates.later}
      </button>
    </div>
  );
}
