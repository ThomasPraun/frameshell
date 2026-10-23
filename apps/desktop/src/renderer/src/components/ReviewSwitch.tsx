import { useState } from "react";
import { t } from "../i18n.js";
import { setReviewEnabled, useReview } from "../review/store.js";

/**
 * The review mode switch (ADR 0019), off by default: "Review agent changes before applying". The same switch
 * is in the File menu; the daemon keeps it per project, and every window of the project follows.
 */
export function ReviewSwitch() {
  const { enabled } = useReview();
  const [failure, setFailure] = useState<string | null>(null);
  // The daemon's answer takes a moment to come back as an event: show the click at once.
  const [asked, setAsked] = useState<boolean | null>(null);
  return (
    <div className="review-switch">
      <label title={t.review.switchHint}>
        <input
          type="checkbox"
          checked={asked ?? enabled}
          onChange={(event) => {
            const wanted = event.currentTarget.checked;
            setAsked(wanted);
            void setReviewEnabled(wanted).then((message) => {
              setFailure(message);
              setAsked(null);
            });
          }}
        />
        {t.review.switchLabel}
      </label>
      {failure && (
        <span className="proposal-failure" role="alert">
          {failure}
        </span>
      )}
    </div>
  );
}
