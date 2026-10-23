import type { AssetInfo, PeopleSuggestion, PersonInfo } from "@frameshell/protocol";
import { type CSSProperties, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { openAskMenu } from "../ask/ask-agent.js";
import { t } from "../i18n.js";
import { editsText } from "../history-commands.js";
import {
  agentOf,
  angleName,
  clock,
  confirmedBy,
  faceViewBox,
  linkChoices,
  personColour,
  speakerName,
} from "../people/model.js";
import { type PersonTime, pickPerson } from "../people/pick.js";
import { peopleActions, usePeople } from "../people/usePeople.js";
import { useAssets } from "../preview/useProgram.js";
import { SELECTION_TIMELINE, selection, useSelection } from "../selection.js";
import { historyShortcut } from "../timeline/edit.js";
import { useTimelineView } from "../timeline/useTimelineView.js";
import { useTranscripts } from "../transcript/useTranscripts.js";

const isMac = navigator.userAgent.includes("Mac");

/** Transcript file as a person reads it: without its folder. */
const fileName = (path: string) => path.replace(/^transcripts\//, "");

/**
 * People (ADR 0020): who is who across transcripts, angles and faces. Suggestions Frameshell found wait for a
 * yes or a no on top; each person lists what is linked to them, marks links that are gone (`missing`) and
 * links an agent confirmed, and picking one selects their words and spans (Speaks or On screen) in the shared
 * selection. Cmd/Ctrl+Z here puts back the last change to people, whoever made it. The panel never writes
 * `people.json`: every change is a daemon call.
 */
export function PeoplePanel({ mediaUrl }: { mediaUrl: string }) {
  const people = usePeople();
  const { view } = useTimelineView(SELECTION_TIMELINE);
  const { sources } = useTranscripts();
  const assets = useAssets(view?.revision ?? null);
  const picked = useSelection();
  const [notice, setNotice] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  const list = people.snapshot.people;
  const choices = useMemo(() => linkChoices(sources, view, list), [sources, view, list]);

  const fail = (error: unknown) => setNotice({ tone: "error", text: t.people.failed((error as Error).message) });
  const run = (work: Promise<unknown>) => {
    setNotice(null);
    work.catch(fail);
  };

  const pick = (person: PersonInfo, what: PersonTime, reveal: boolean) =>
    void pickPerson(person, what, { view, sources, info: person }, { reveal }).then((error) =>
      // A refresh after an edit must not wipe the message of that edit (an undo's, say).
      setNotice((current) => (error ? { tone: "error", text: t.people.rangesFailed(error) } : reveal ? null : current)),
    );

  // A new revision, a changed transcript or a changed person moves the picked person's words and spans.
  const selected = picked.person;
  const info = selected ? list.find((person) => person.id === selected.id) : undefined;
  const first = useRef(true);
  const links = info ? JSON.stringify([info.name, info.speakers, info.angles, info.faces]) : "";
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const current = selection.get().person;
    if (!current) return;
    if (!info) {
      if (people.status === "ready") selection.clear();
      return;
    }
    pick(info, current.what, false);
    // Runs on what moves a person's spans only; `pick` reads the rest as it is now.
  }, [view?.revision, sources, links]);

  // Suggestions read transcripts and multicam groups: new speakers or angles change them without a people event.
  const groups = JSON.stringify(view?.groups?.map((group) => [group.id, group.angles.map((angle) => [angle.id, angle.name, angle.screen])]) ?? []);
  const seen = useRef(false);
  useEffect(() => {
    if (!seen.current) {
      seen.current = true;
      return;
    }
    void peopleActions.refreshSuggestions();
  }, [sources, groups]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (historyShortcut(event.nativeEvent, isMac) !== "undo" || editsText(event.target)) return;
    // Handled here, so neither the timeline's undo nor the Edit menu also runs.
    event.preventDefault();
    event.stopPropagation();
    const entry = people.undo;
    if (!entry) return setNotice({ tone: "info", text: t.people.nothingToUndo });
    peopleActions.undo().then(
      () => setNotice({ tone: "info", text: t.people.undone(describe(entry.change)) }),
      (error: Error) => setNotice({ tone: "error", text: t.people.undoFailed(error.message) }),
    );
  };

  const add = () => {
    const next = name.trim();
    if (!next) return;
    setName("");
    run(peopleActions.add(next));
  };

  const faceCount = people.suggestions.filter((suggestion) => suggestion.face).length;
  return (
    <div className="people-panel" data-testid="people-panel" tabIndex={-1} onKeyDown={onKeyDown} aria-label={t.people.panel}>
      <form
        className="people-add"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <input
          className="people-input"
          data-testid="people-name"
          value={name}
          placeholder={t.people.addPlaceholder}
          aria-label={t.people.addLabel}
          onChange={(event) => setName(event.target.value)}
        />
        <button className="button" type="submit" disabled={name.trim() === ""} data-testid="people-add">
          {t.people.add}
        </button>
      </form>
      <div className="people-scan">
        <button className="button" onClick={() => run(peopleActions.scan())} disabled={people.scan.running} data-testid="people-scan">
          {t.people.scan}
        </button>
        {people.scan.running && (
          <span className="people-scan-state" role="status" data-testid="people-scan-state">
            {t.people.scanning(`${Math.round(people.scan.progress * 100)}`)}
          </span>
        )}
        {people.scan.error && (
          <span className="people-scan-state people-error" role="alert">
            {t.people.scanFailed(people.scan.error)}
          </span>
        )}
      </div>
      {notice && (
        <p className={`people-notice${notice.tone === "error" ? " people-error" : ""}`} role={notice.tone === "error" ? "alert" : "status"} data-testid="people-notice">
          {notice.text}
        </p>
      )}
      {people.status === "error" && <p className="people-notice people-error" role="alert">{t.people.loadFailed(people.error ?? "")}</p>}
      {people.status === "loading" && <p className="empty">{t.people.loading}</p>}

      {people.suggestions.length > 0 && (
        <section aria-label={t.people.suggestions} data-testid="people-suggestions" data-faces={faceCount}>
          <h3 className="people-heading">{t.people.suggestions}</h3>
          <ul className="people-list">
            {people.suggestions.map((suggestion) => (
              <SuggestionRow
                key={suggestion.id}
                suggestion={suggestion}
                people={list}
                assets={assets}
                mediaUrl={mediaUrl}
                onConfirm={(who) => run(peopleActions.confirm(suggestion.id, who))}
                onDismiss={() => run(peopleActions.dismiss(suggestion.id))}
              />
            ))}
          </ul>
        </section>
      )}

      {people.status === "ready" && list.length === 0 && <p className="empty">{t.people.empty}</p>}
      <ul className="people-list" data-testid="people-list">
        {list.map((person) => {
          const isPicked = selected?.id === person.id;
          const agent = confirmedBy(person);
          return (
            <li
              key={person.id}
              className={`person${isPicked ? " is-selected" : ""}`}
              style={{ "--person-color": `var(--angle-${personColour(person.id) + 1})` } as CSSProperties}
              data-testid="person"
              data-person={person.id}
              data-name={person.name}
              data-selected={isPicked}
              onContextMenu={(event) => {
                pick(person, selected?.id === person.id ? selected.what : "speaks", false);
                openAskMenu(event);
              }}
            >
              <div className="person-head">
                {renaming === person.id ? (
                  <input
                    className="people-input"
                    data-testid="person-rename-input"
                    defaultValue={person.name}
                    aria-label={t.people.rename(person.name)}
                    autoFocus
                    onFocus={(event) => event.currentTarget.select()}
                    onBlur={() => setRenaming(null)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setRenaming(null);
                      else if (event.key === "Enter") {
                        const next = event.currentTarget.value.trim();
                        setRenaming(null);
                        if (next && next !== person.name) run(peopleActions.rename(person.id, next));
                      } else return;
                      event.preventDefault();
                    }}
                  />
                ) : (
                  <button
                    className="person-name"
                    aria-pressed={isPicked}
                    data-testid="person-select"
                    onClick={() => (isPicked ? selection.clear() : pick(person, "speaks", true))}
                  >
                    <span className="person-swatch" aria-hidden="true" />
                    <span className="person-label">{person.name}</span>
                  </button>
                )}
                {agent && (
                  <span className="person-agent" title={t.people.byAgentTitle(agent)} data-testid="person-agent">
                    {t.people.byAgent}
                  </span>
                )}
                <button className="icon-button" aria-label={t.people.rename(person.name)} title={t.people.rename(person.name)} onClick={() => setRenaming(person.id)} data-testid="person-rename">
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M3 13H6L13 6L10 3L3 10V13Z" fill="none" stroke="currentColor" strokeWidth="1.3" />
                  </svg>
                </button>
                <button className="icon-button" aria-label={t.people.remove(person.name)} title={t.people.remove(person.name)} onClick={() => run(peopleActions.remove(person.id))} data-testid="person-remove">
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M4 4L12 12M12 4L4 12" fill="none" stroke="currentColor" strokeWidth="1.3" />
                  </svg>
                </button>
              </div>
              {isPicked && selected && (
                <div className="person-pick" data-testid="person-pick">
                  <div className="person-toggle" role="group" aria-label={t.people.show}>
                    {(["speaks", "onscreen"] as const).map((what) => (
                      <button key={what} className={selected.what === what ? "is-active" : ""} aria-pressed={selected.what === what} data-testid={`person-${what}`} onClick={() => pick(person, what, true)}>
                        {what === "speaks" ? t.people.speaks : t.people.onScreen}
                      </button>
                    ))}
                  </div>
                  <span className="person-spans" data-testid="person-spans">
                    {picked.spans.length > 0
                      ? t.people.spans(`${picked.spans.length}`, clock(picked.spans.reduce((sum, { from, to }) => sum + (to - from), 0)))
                      : t.people.noSpans}
                  </span>
                </div>
              )}
              <ul className="person-links">
                {person.speakers.map((link) => (
                  <LinkChip
                    key={`${link.transcript}:${link.speaker ?? "*"}`}
                    label={link.speaker ? t.people.voice(speakerName(sources, link.transcript, link.speaker), fileName(link.transcript)) : t.people.voiceWhole(fileName(link.transcript))}
                    link={link}
                    kind="voice"
                    onUnlink={() => run(peopleActions.unlink(person.id, { speaker: { transcript: link.transcript, ...(link.speaker ? { speaker: link.speaker } : {}) } }))}
                  />
                ))}
                {person.angles.map((link) => (
                  <LinkChip
                    key={`${link.timeline}:${link.group}:${link.angle}`}
                    label={t.people.angle(angleName(view, link.group, link.angle))}
                    link={link}
                    kind="angle"
                    onUnlink={() => run(peopleActions.unlink(person.id, { angle: { timeline: link.timeline, group: link.group, angle: link.angle } }))}
                  />
                ))}
                {person.faces.map((link) => (
                  <LinkChip
                    key={`${link.asset}:${link.at}:${link.x}:${link.y}`}
                    label={t.people.face(link.asset.replace(/^assets\//, ""), clock(link.at))}
                    link={link}
                    kind="face"
                    onUnlink={() => run(peopleActions.unlink(person.id, { face: { asset: link.asset, at: link.at, x: link.x, y: link.y } }))}
                  />
                ))}
              </ul>
              {choices.length > 0 && (
                <select
                  className="people-input person-link-pick"
                  data-testid="person-link-pick"
                  aria-label={t.people.link}
                  value=""
                  onChange={(event) => {
                    const choice = choices.find((candidate) => candidate.key === event.target.value);
                    if (choice) run(peopleActions.link(person.id, choice.target));
                  }}
                >
                  <option value="">{t.people.linkPlaceholder}</option>
                  {(["voice", "angle"] as const).map((kind) => {
                    const own = choices.filter((choice) => choice.kind === kind);
                    const groups = [...new Set(own.map((choice) => choice.group))];
                    return groups.map((group) => (
                      <optgroup key={`${kind}:${group}`} label={kind === "voice" ? `${t.people.linkVoices} · ${fileName(group)}` : t.people.linkAngles}>
                        {own
                          .filter((choice) => choice.group === group)
                          .map((choice) => (
                            <option key={choice.key} value={choice.key}>
                              {choice.label}
                            </option>
                          ))}
                      </optgroup>
                    ));
                  })}
                </select>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** What an undone change was, for the status line. */
function describe(change: { kind: "add" | "rename" | "remove" | "link" | "unlink"; name: string; from?: string }): string {
  switch (change.kind) {
    case "add":
      return t.people.changeAdd(change.name);
    case "rename":
      return t.people.changeRename(change.from ?? "", change.name);
    case "remove":
      return t.people.changeRemove(change.name);
    case "link":
      return t.people.changeLink(change.name);
    case "unlink":
      return t.people.changeUnlink(change.name);
  }
}

/** One link of a person: what it is, `missing` when its target is gone, and a way to remove it. */
function LinkChip({
  label,
  link,
  kind,
  onUnlink,
}: {
  label: string;
  link: { missing: boolean; reason?: string | undefined; by?: string | undefined };
  kind: "voice" | "angle" | "face";
  onUnlink: () => void;
}) {
  const agent = agentOf(link.by);
  return (
    <li className={`person-link${link.missing ? " is-missing" : ""}`} data-testid="person-link" data-kind={kind} data-missing={link.missing} data-by={agent ?? undefined}>
      <span className="person-link-label">{label}</span>
      {link.missing && (
        <span className="person-link-missing" title={t.people.missingTitle(link.reason ?? "")}>
          {t.people.missing}
        </span>
      )}
      {agent && <span className="person-link-agent" title={t.people.byAgentTitle(agent)} aria-label={t.people.byAgentTitle(agent)} />}
      <button className="icon-button" aria-label={t.people.unlink(label)} title={t.people.unlink(label)} onClick={onUnlink} data-testid="person-unlink">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>
    </li>
  );
}

/** What confirming an `angle` suggestion links besides the angle: its mic's voice and the face most on its screen. */
function angleExtras(suggestion: PeopleSuggestion): string | null {
  const parts: string[] = [];
  const { speaker } = suggestion;
  if (speaker && suggestion.links.includes("speaker")) {
    parts.push(speaker.speaker ? t.people.voice(speaker.name ?? speaker.speaker, fileName(speaker.transcript)) : t.people.voiceWhole(fileName(speaker.transcript)));
  }
  if (suggestion.face && suggestion.links.includes("face")) parts.push(t.people.angleFace);
  return parts.length > 0 ? t.people.angleAlso(parts.join(", ")) : null;
}

/** What a suggestion says, in the UI's language. */
function suggestionText(suggestion: PeopleSuggestion): string {
  const { speaker, person, score } = suggestion;
  const points = score === undefined ? "" : score.toFixed(2);
  const voice = speaker?.name ?? speaker?.speaker ?? "";
  if (suggestion.kind === "speaker" && speaker && person) return t.people.suggestSpeaker(voice, fileName(speaker.transcript), person.name, points);
  if (suggestion.kind === "face-speaker" && speaker) {
    return person ? t.people.suggestFaceSpeaker(voice, fileName(speaker.transcript), person.name) : t.people.suggestFaceSpeakerNew(voice, fileName(speaker.transcript));
  }
  if (suggestion.kind === "face") return person ? t.people.suggestFace(person.name, points) : t.people.whoIsThis;
  if (suggestion.kind === "angle" && suggestion.angle) {
    return person ? t.people.suggestAngle(suggestion.angle.name, person.name) : t.people.suggestAngleNew(suggestion.angle.name);
  }
  // Kinds this app does not know yet read as the daemon words them.
  return t.people.suggestOther(suggestion.reason);
}

function SuggestionRow({
  suggestion,
  people,
  assets,
  mediaUrl,
  onConfirm,
  onDismiss,
}: {
  suggestion: PeopleSuggestion;
  people: readonly PersonInfo[];
  assets: ReadonlyMap<string, AssetInfo> | null;
  mediaUrl: string;
  onConfirm: (person: string | undefined) => void;
  onDismiss: () => void;
}) {
  // A new person from an angle takes the angle's name unless the field says otherwise.
  const fromAngle = suggestion.kind === "angle" && !suggestion.person ? (suggestion.angle?.name ?? "") : "";
  const [who, setWho] = useState(fromAngle);
  const needsName = !suggestion.person;
  const extras = suggestion.kind === "angle" ? angleExtras(suggestion) : null;
  const listId = `people-names-${suggestion.id}`;
  return (
    <li className="suggestion" data-testid="suggestion" data-kind={suggestion.kind} data-suggestion={suggestion.id}>
      {suggestion.face && <FaceThumb face={suggestion.face} asset={assets?.get(suggestion.face.anchor.asset)} mediaUrl={mediaUrl} />}
      <div className="suggestion-body">
        <p className="suggestion-text">{suggestionText(suggestion)}</p>
        {extras && (
          <p className="suggestion-meta" data-testid="suggestion-also">
            {extras}
          </p>
        )}
        {suggestion.face && suggestion.kind !== "angle" && <p className="suggestion-meta">{t.people.faceSeconds(`${Math.round(suggestion.face.seconds)}`)}</p>}
        {needsName && (
          <>
            <input
              className="people-input"
              data-testid="suggestion-name"
              list={listId}
              value={who}
              placeholder={t.people.whoNamePlaceholder}
              aria-label={fromAngle ? t.people.newPersonName : t.people.whoName}
              onChange={(event) => setWho(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && who.trim()) onConfirm(who.trim());
              }}
            />
            <datalist id={listId}>
              {people.map((person) => (
                <option key={person.id} value={person.name} />
              ))}
            </datalist>
          </>
        )}
        <div className="suggestion-actions">
          <button className="button primary" data-testid="suggestion-confirm" disabled={needsName && who.trim() === ""} onClick={() => onConfirm(needsName ? who.trim() : undefined)}>
            {t.people.confirm}
          </button>
          <button className="button" data-testid="suggestion-dismiss" onClick={onDismiss}>
            {t.people.dismiss}
          </button>
        </div>
      </div>
    </li>
  );
}

/**
 * The face of a suggestion: the frame of the video's proxy at the anchor, cropped to the face with
 * `object-view-box` (as the multicam viewer crops a tile). Nothing is stored: it is drawn again each time.
 */
function FaceThumb({
  face,
  asset,
  mediaUrl,
}: {
  face: NonNullable<PeopleSuggestion["face"]>;
  asset: AssetInfo | undefined;
  mediaUrl: string;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const proxy = asset?.proxy ?? null;
  const src = proxy ? mediaUrl + proxy.split("/").map(encodeURIComponent).join("/") : null;
  const size = asset?.media?.video;
  const viewBox = faceViewBox(face.anchor, size ? size.width / size.height : 16 / 9);
  useEffect(() => {
    const element = video.current;
    if (!element || !src) return;
    const seek = () => {
      element.currentTime = face.anchor.at;
    };
    if (element.readyState >= 1) seek();
    else element.addEventListener("loadedmetadata", seek, { once: true });
    return () => element.removeEventListener("loadedmetadata", seek);
  }, [src, face.anchor.at]);
  return (
    <div className="face-thumb" data-testid="face-thumb" role="img" aria-label={t.people.faceThumbnail}>
      {src && (
        <video
          ref={video}
          src={src}
          muted
          playsInline
          preload="auto"
          disablePictureInPicture
          style={{ objectViewBox: viewBox } as CSSProperties}
        />
      )}
    </div>
  );
}
