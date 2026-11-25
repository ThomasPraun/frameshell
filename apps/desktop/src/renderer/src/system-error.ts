// File-system failures in words (#748): Node's `EEXIST: file already exists, mkdir '…'` reached the status bar as is,
// in English, for four seconds. Pure, so the mapping is unit tested.
import { t } from "./i18n.js";

/** Codes said in words; any other message shows as it is. */
const CODES = ["EACCES", "EPERM", "ENOTDIR", "EEXIST", "ENOSPC", "EROFS", "ENOENT"] as const;

/**
 * `message` (an Error's, possibly wrapped by IPC as `Error invoking remote method '…': Error: EEXIST: …`) in words
 * when it is a file-system failure Node reports by code, with the path it names; null for any other message.
 */
export function systemErrorText(message: string): string | null {
  const found = /\b(E[A-Z]+): [^,]*(?:, \w+ '([^']*)'(?: -> '[^']*')?)?/.exec(message);
  const code = CODES.find((each) => each === found?.[1]);
  if (!found || !code) return null;
  return t.workspace.systemErrors[code](found[2] ?? "");
}
