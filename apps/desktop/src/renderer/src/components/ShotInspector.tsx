import type { TimelineView } from "@frameshell/protocol";
import { DEFAULT_SHOT_CORNER, SHOT_ANGLE_COUNTS, SHOT_CORNERS, SHOT_LAYOUTS, type ShotCorner, type ShotLayout, reframePointAt } from "@frameshell/schema";
import { useEffect, useMemo, useState } from "react";
import type { TimelineEdit } from "../../../shared/api.js";
import { t } from "../i18n.js";
import { useTransport } from "../preview/transport.js";
import { SELECTION_TIMELINE } from "../selection.js";
import { ANGLE_COLOR_COUNT, type ClipBox, type ShotBox, type TrackRow, layoutName, layoutTimeline } from "../timeline/layout.js";
import { useTimelineView } from "../timeline/useTimelineView.js";
import { sendClipEdit } from "./clip-edits.js";
import { Choice, NumberField, TextField } from "./inspector-fields.js";

type Group = NonNullable<TimelineView["groups"]>[number];
type Angle = Group["angles"][number];

const LAYOUT_TITLES: Record<ShotLayout, string> = {
  solo: t.inspector.layoutSoloTitle,
  "two-up": t.inspector.layoutTwoUpTitle,
  grid: t.inspector.layoutGridTitle,
  screen: t.inspector.layoutScreenTitle,
  pip: t.inspector.layoutPipTitle,
};

/** Edits from one inspector, with the daemon's refusal shown in it; `send` resolves false on a refusal. */
function useSender(key: string): { error: string | null; send: (edit: TimelineEdit) => Promise<boolean> } {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [key]);
  const send = (edit: TimelineEdit) => {
    setError(null);
    return sendClipEdit(edit).then(
      () => true,
      (failure: unknown) => {
        setError((failure as Error).message);
        return false;
      },
    );
  };
  return { error, send };
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <span className="clip-inspector-error" role="status" title={error}>
      {error}
    </span>
  ) : null;
}

function Swatch({ color }: { color: number }) {
  return <span className="angle-swatch" style={{ background: `var(--angle-${(color % ANGLE_COLOR_COUNT) + 1})` }} aria-hidden="true" />;
}

/**
 * Settings of a selected shot (ADR 0016): its layout and the angles it shows,
 * each change one `shot.set` by `ui`; where it cuts each angle
 * ({@link ShotReframe}); the director's confidence and reason; and, folded
 * out, its group's angles ({@link GroupAngles}).
 */
export function ShotInspector({ row, clip, shot, view }: { row: TrackRow; clip: ClipBox; shot: ShotBox; view: TimelineView }) {
  const { error, send } = useSender(clip.id);
  const [anglesOpen, setAnglesOpen] = useState(false);
  const group = view.groups?.find((candidate) => candidate.id === row.group);
  const shown = shot.angles.map((angle) => angle.id);
  const setAngles = (angles: string[]) => send({ op: "shot.set", args: { clip: clip.id, angles } });
  const layout = shot.layout as ShotLayout;
  const max = SHOT_ANGLE_COUNTS[layout]?.[1] ?? 1;
  const unused = group?.angles.filter((angle) => !shown.includes(angle.id)) ?? [];
  const removable = shown.length > (SHOT_ANGLE_COUNTS[layout]?.[0] ?? 1);

  return (
    <div className="clip-inspector shot-inspector" role="group" aria-label={t.inspector.settingsOfShot(clip.name)} data-clip={clip.id}>
      <span className="clip-inspector-name" title={t.inspector.clipOnTrack(clip.id, row.label)}>
        <span className="clip-inspector-track track-program">{row.label}</span>
        {t.inspector.shot}
      </span>
      <Choice
        label={t.inspector.layout}
        options={SHOT_LAYOUTS.map((id) => ({ id, label: layoutName(id), title: LAYOUT_TITLES[id] }))}
        value={shot.layout}
        onPick={(id) => send({ op: "shot.set", args: { clip: clip.id, shot: id as ShotLayout } })}
      />
      {shot.layout === "pip" && (
        <Choice
          label={t.inspector.corner}
          options={SHOT_CORNERS.map((id) => ({ id, label: t.inspector.corners[id], title: t.inspector.cornerTitle(t.inspector.corners[id]) }))}
          value={(shot.corner as ShotCorner | null) ?? DEFAULT_SHOT_CORNER}
          onPick={(id) => send({ op: "shot.set", args: { clip: clip.id, corner: id as ShotCorner } })}
        />
      )}
      <div className="clip-inspector-group" role="group" aria-label={t.inspector.shownAngles}>
        {shot.angles.map((angle, index) => (
          <span key={`${index}:${angle.id}`} className="angle-slot">
            <Swatch color={angle.color} />
            <select
              className="clip-field-select"
              aria-label={t.inspector.angleSlot(index + 1)}
              title={t.inspector.angleSlotTitle}
              value={angle.id}
              onChange={(event) => {
                const next = [...shown];
                const other = next.indexOf(event.target.value);
                // Picking an angle shown in another slot swaps the two.
                if (other >= 0) next[other] = angle.id;
                next[index] = event.target.value;
                setAngles(next);
              }}
            >
              {(group?.angles ?? [{ id: angle.id, name: angle.name } as Angle]).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
            {removable && (
              <button
                className="clip-inspector-button angle-remove"
                title={t.inspector.removeAngleTitle(angle.name)}
                aria-label={t.inspector.removeAngleTitle(angle.name)}
                onClick={() => setAngles(shown.filter((id) => id !== angle.id))}
              >
                ×
              </button>
            )}
          </span>
        ))}
        {shown.length < max && unused.length > 0 && (
          <select
            className="clip-field-select"
            aria-label={t.inspector.addAngle}
            title={t.inspector.addAngleTitle}
            value=""
            onChange={(event) => event.target.value && setAngles([...shown, event.target.value])}
          >
            <option value="">{t.inspector.addAngle}</option>
            {unused.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {group && <ShotReframe clip={clip} shot={shot} group={group} />}
      {shot.confidence !== null && (
        <span className={`clip-inspector-hint shot-verdict${shot.doubtful ? " is-doubtful" : ""}`} title={t.inspector.directorTitle}>
          {t.inspector.director(Math.round(shot.confidence * 100), shot.reason)}
        </span>
      )}
      {group && (
        <button
          className={`clip-inspector-button${anglesOpen ? " is-open" : ""}`}
          aria-expanded={anglesOpen}
          title={t.inspector.editAnglesTitle}
          onClick={() => setAnglesOpen(!anglesOpen)}
        >
          {t.inspector.editAngles}
        </button>
      )}
      <ErrorLine error={error} />
      {group && anglesOpen && <GroupAngles group={group} colors={angleColors(group)} />}
    </div>
  );
}

/**
 * The reframe point of each angle the shot cuts to its tile (every angle but
 * a `screen` shot's and a `pip` shot's screen) at the playhead, or at the
 * shot's first frame while the playhead is outside it. A change sets one
 * `multicam.reframe` key there; keys live in the group, so every shot of the
 * angle follows them. Nothing moves at the pictures' own aspect: the preview's
 * 9:16 frame shows the cut.
 */
function ShotReframe({ clip, shot, group }: { clip: ClipBox; shot: ShotBox; group: Group }) {
  const { error, send } = useSender(`${clip.id}/reframe`);
  const { time, fps } = useTransport();
  const at = time >= clip.start && time < clip.end ? time : clip.start;
  const groupSecond = clip.in + (at - clip.start);
  const cut = shot.layout === "screen" ? [] : shot.layout === "pip" ? shot.angles.slice(1) : shot.angles;
  const angles = cut.flatMap((shown) => group.angles.find((angle) => angle.id === shown.id) ?? []);
  if (angles.length === 0) return null;
  const reframe = (angle: Angle, change: Omit<Extract<TimelineEdit, { op: "multicam.reframe" }>["args"], "group" | "angle">) =>
    send({ op: "multicam.reframe", args: { group: group.id, angle: angle.id, ...change } });
  return (
    <div className="clip-inspector-group shot-reframe" role="group" aria-label={t.inspector.reframe} title={t.inspector.reframeGroupTitle}>
      <span className="clip-field-label is-static">{t.inspector.reframe}</span>
      {angles.map((angle) => {
        const point = reframePointAt(angle, groupSecond);
        const keys = angle.reframe ?? [];
        const keyHere = keys.some((key) => Math.abs(key.at - groupSecond) < 0.5 / fps);
        return (
          <span key={angle.id} className="angle-slot reframe-row" role="group" aria-label={t.inspector.reframeRow(angle.name)} data-angle={angle.id}>
            <span className="clip-inspector-hint">{angle.name}</span>
            <NumberField name="reframeX" stored={point.x} onCommit={(x) => reframe(angle, { time: at, x })} />
            <NumberField name="reframeY" stored={point.y} onCommit={(y) => reframe(angle, { time: at, y })} />
            <span className="clip-inspector-hint" title={t.inspector.reframeKeysTitle} data-testid="reframe-keys">
              {t.inspector.reframeKeys(keys.length)}
            </span>
            {keyHere && (
              <button className="clip-inspector-button" title={t.inspector.removeKeyTitle} onClick={() => reframe(angle, { time: at, remove: true })}>
                {t.inspector.removeKey}
              </button>
            )}
            {keys.length > 0 && (
              <button className="clip-inspector-button" title={t.inspector.clearKeysTitle} onClick={() => reframe(angle, { clear: true })}>
                {t.inspector.clearKeys}
              </button>
            )}
          </span>
        );
      })}
      <ErrorLine error={error} />
    </div>
  );
}

/** Settings of a selected program track: the angles of the group it shows. */
export function GroupInspector({ track }: { track: string }) {
  const { view } = useTimelineView(SELECTION_TIMELINE);
  const layout = useMemo(() => (view ? layoutTimeline(view) : null), [view]);
  const row = layout?.rows.find((candidate) => candidate.id === track);
  const group = view?.groups?.find((candidate) => candidate.id === row?.group);
  if (!row || !group) return null;
  return (
    <div className="clip-inspector group-inspector" role="group" aria-label={t.inspector.settingsOfGroup(row.label)} data-track={track}>
      <span className="clip-inspector-name" title={group.id}>
        <span className="clip-inspector-track track-program">{row.label}</span>
        {row.name ?? group.name ?? group.id}
      </span>
      <GroupAngles group={group} colors={angleColors(group)} />
    </div>
  );
}

/** Colour slot of each angle: its place in the group, as the timeline paints it. */
function angleColors(group: Group): Map<string, number> {
  return new Map(group.angles.map((angle, index) => [angle.id, index % ANGLE_COLOR_COUNT]));
}

/**
 * One row per angle of a multicam group: name, sync offset, crop per side,
 * gain, mute and screen flag. Each change is one `multicam.angle` (`multicam.offset` for
 * the sync) by `ui`, undoable like any edit; preview and export follow.
 */
function GroupAngles({ group, colors }: { group: Group; colors: ReadonlyMap<string, number> }) {
  const { error, send } = useSender(group.id);
  const set = (angle: Angle, change: Omit<Extract<TimelineEdit, { op: "multicam.angle" }>["args"], "group" | "angle">) =>
    send({ op: "multicam.angle", args: { group: group.id, angle: angle.id, ...change } });
  return (
    <div className="group-angles" role="group" aria-label={t.inspector.groupAngles}>
      {group.angles.map((angle) => {
        const crop = angle.crop ?? {};
        const muted = angle.audio?.muted === true;
        // With a mic (or none) the level belongs to the mic, edited by the agent or CLI: `multicam.mic`.
        const heard = angle.mic === undefined;
        const screen = angle.screen === true;
        return (
          <div key={angle.id} className="clip-inspector-group angle-row" role="group" aria-label={t.inspector.angleRow(angle.name)} data-angle={angle.id}>
            <Swatch color={colors.get(angle.id) ?? 0} />
            <TextField label={t.inspector.fieldName} title={t.inspector.fieldNameTitle(angle.id)} stored={angle.name} onCommit={(name) => set(angle, { name })} />
            <NumberField
              name="offset"
              stored={angle.offset}
              onCommit={(offset) => send({ op: "multicam.offset", args: { group: group.id, angle: angle.id, offset } })}
            />
            <NumberField name="cropLeft" stored={crop.left ?? 0} onCommit={(left) => set(angle, { crop: { left } })} />
            <NumberField name="cropTop" stored={crop.top ?? 0} onCommit={(top) => set(angle, { crop: { top } })} />
            <NumberField name="cropRight" stored={crop.right ?? 0} onCommit={(right) => set(angle, { crop: { right } })} />
            <NumberField name="cropBottom" stored={crop.bottom ?? 0} onCommit={(bottom) => set(angle, { crop: { bottom } })} />
            <NumberField name="gain" stored={angle.audio?.gain ?? 0} disabled={muted || !heard} onCommit={(gain) => set(angle, { gain })} />
            <button
              className={`clip-inspector-button clip-inspector-mute${muted ? " on" : ""}`}
              aria-pressed={muted}
              title={!heard ? t.inspector.soundFromMicTitle : muted ? t.inspector.unmuteAngleTitle : t.inspector.muteAngleTitle}
              disabled={!heard}
              onClick={() => set(angle, { muted: !muted })}
            >
              {t.inspector.mute}
            </button>
            <button
              className={`clip-inspector-button clip-inspector-screen${screen ? " on" : ""}`}
              aria-pressed={screen}
              title={screen ? t.inspector.unscreenAngleTitle : t.inspector.screenAngleTitle}
              onClick={() => set(angle, { screen: !screen })}
            >
              {t.inspector.screen}
            </button>
          </div>
        );
      })}
      <ErrorLine error={error} />
    </div>
  );
}
