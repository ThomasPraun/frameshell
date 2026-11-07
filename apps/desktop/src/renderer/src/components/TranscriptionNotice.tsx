import { useEffect, useState } from "react";
import { t } from "../i18n.js";
import { takes, useTakes } from "../shoot/takes.js";

const INSTALL_COMMAND = "frameshell plugin install @frameshell/whisper-cpp";

/**
 * Shown in the Shoot view while the project's transcription provider does not load (#411): takes cut then are never
 * compared. Offers the default provider in one click; the daemon transcribes the takes that failed once it is in.
 */
export function TranscriptionNotice() {
  const { status } = useTakes();
  const transcription = status?.transcription ?? null;
  const missing = transcription !== null && !transcription.ready;
  const offer = missing && transcription.provider === "whisper-cpp";
  const [bytes, setBytes] = useState<number | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!offer) return;
    let current = true;
    window.frameshell.shoot.transcriptionDownload().then(
      (found) => current && setBytes(found),
      () => current && setBytes(0),
    );
    return () => {
      current = false;
    };
  }, [offer]);

  if (!missing) return null;
  const install = async () => {
    setInstalling(true);
    setError(null);
    try {
      await window.frameshell.shoot.installTranscription();
      await takes.reload();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setInstalling(false);
    }
  };
  return (
    <div className="shoot-transcription" role="status" data-testid="shoot-no-transcription">
      <p className="shoot-note">{t.shoot.noTranscription}</p>
      {transcription.problem && <p className="shoot-note">{t.shoot.transcriptionProblem(transcription.problem)}</p>}
      {offer && (
        <div className="shoot-row">
          <button className="button" data-testid="shoot-install-transcription" disabled={installing || bytes === null} onClick={() => void install()}>
            {installing ? t.shoot.installingTranscription : t.shoot.installTranscription(Math.round((bytes ?? 0) / 1_000_000))}
          </button>
          <span className="shoot-note">{t.shoot.transcriptionCommand(INSTALL_COMMAND)}</span>
        </div>
      )}
      {error && <p className="shoot-error">{t.shoot.failed(error)}</p>}
    </div>
  );
}
