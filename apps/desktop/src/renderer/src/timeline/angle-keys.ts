// Keys 1-9 and Shift+1-9 cut to an angle (#242). Pure: Workspace listens, `cutToAngle` cuts.
import { editsText } from "../history-commands.js";
import { elementOf } from "../windows.js";

type AngleKeyEvent = Pick<KeyboardEvent, "code" | "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "repeat" | "isComposing" | "target">;

/** What a key press asks of the angles (1-based, group order; Shift adds to the shot), or null when it is not an angle key. */
export function angleKey(event: AngleKeyEvent): { number: number; additive: boolean } | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.isComposing) return null;
  const match = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
  // NumLock off (or Shift on Windows) makes the keypad send End, Home, arrows under code NumpadN: those belong to the playhead.
  if (match && match[0].startsWith("Numpad") && event.key !== match[1]) return null;
  if (!match || editsText(event.target) || elementOf(event.target)?.tagName === "SELECT") return null;
  return { number: Number(match[1]), additive: event.shiftKey };
}
