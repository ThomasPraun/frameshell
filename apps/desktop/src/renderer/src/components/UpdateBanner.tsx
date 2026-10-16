import { useEffect, useState } from "react";
import type { UpdateStatus } from "../../../shared/api.js";

/** User-visible strings of the banner. Main's dialogs and menu items: `UPDATE_TEXT` in `main/update-check.ts`. */
const TEXT = {
  available: (version: string) => `Frameshell ${version} is available.`,
  ready: (version: string) => `Frameshell ${version} is ready to install.`,
  download: "Download",
  restart: "Restart to Update",
  later: "Later",
} as const;

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
      <p>{status.state === "ready" ? TEXT.ready(status.version) : TEXT.available(status.version)}</p>
      {status.state === "ready" ? (
        <button className="button primary" onClick={() => window.frameshell.updates.restart()}>
          {TEXT.restart}
        </button>
      ) : (
        // Opened in the browser by main's window-open handler.
        <a className="button primary" href={status.url} target="_blank" rel="noreferrer">
          {TEXT.download}
        </a>
      )}
      <button className="link" onClick={() => window.frameshell.updates.dismiss()}>
        {TEXT.later}
      </button>
    </div>
  );
}
