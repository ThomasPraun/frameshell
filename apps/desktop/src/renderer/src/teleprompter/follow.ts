// Live following (ADR 0024 decisions 5 and 6): while a teleprompter shows a script, follow is on and recognition is
// ready, the Shoot view's mic (and system audio) goes to the recognizer, and each window of heard words moves the
// teleprompter through the pure follower. The person's keys resync it; a hold makes it wait.
import { type NumberLanguage, numberLanguage } from "@frameshell/schema";
import { useEffect } from "react";
import { live } from "../shoot/live.js";
import { shouldWake } from "../shoot/live-state.js";
import { shoot } from "../shoot/recorder.js";
import { type FollowScript, type FollowState, follow, followAt, followScript, followStop } from "./follower.js";
import { type PromptPosition, type PromptStream, positionOf, stopOf } from "./model.js";
import { teleprompter } from "./store.js";

/** Follow live recognition with the teleprompter showing `stream` while `on`; nothing while `stream` is null. */
export function useLiveFollow(stream: PromptStream | null, on: boolean): void {
  useEffect(() => {
    if (!stream || !on) return;
    const scripts = new Map<NumberLanguage | null, FollowScript>();
    const scriptFor = (language: NumberLanguage | null) => {
      let script = scripts.get(language);
      if (!script) scripts.set(language, (script = followScript(stream, language)));
      return script;
    };
    let language: NumberLanguage | null = null;
    let state: FollowState | null = null;
    let placed: PromptPosition | null = null;

    // Where the reader is as the follower sees it: again from the store whenever someone else moved it.
    const sync = (): FollowState | null => {
      const position = teleprompter.get().position;
      if (position !== placed || !state) {
        const stop = position ? stopOf(stream, position) : -1;
        state = stop === -1 ? null : followAt(stream, scriptFor(language), stop);
        placed = position;
      }
      return state;
    };

    const offHeard = live.onHeard((heard) => {
      if (teleprompter.get().held) return;
      language = numberLanguage(heard.language) ?? language;
      const current = sync();
      if (!current) return;
      const script = scriptFor(language);
      const before = followStop(stream, script, current);
      const step = follow(stream, script, current, heard, language);
      state = step.state;
      if (!step.moved) return;
      const stop = followStop(stream, script, step.state);
      const position = positionOf(stream, stop);
      if (!position || !teleprompter.setPosition(position, "follow")) return;
      placed = teleprompter.get().position;
      const kept = stop < before ? teleprompter.get().skipped.filter((mark) => stopOf(stream, mark) < stop) : teleprompter.get().skipped;
      const added = step.skipped.flatMap((sentence) => {
        const mark = positionOf(stream, stream.sentences[sentence]!.start);
        return mark ? [mark] : [];
      });
      if (added.length > 0 || kept.length !== teleprompter.get().skipped.length) teleprompter.setSkipped([...kept, ...added]);
    });

    // A move by keys back over marked sentences takes their marks away.
    const offMoves = teleprompter.subscribe(() => {
      const { position, skipped } = teleprompter.get();
      if (position === placed || !position || skipped.length === 0) return;
      const stop = stopOf(stream, position);
      const kept = skipped.filter((mark) => stopOf(stream, mark) < stop);
      if (kept.length !== skipped.length) teleprompter.setSkipped(kept);
    });

    // Off after main stopped the idle server: start it again (never downloads).
    const feed = () => {
      if (shouldWake(live.status(), true)) live.warm();
      live.listen(live.status().state === "ready" ? shoot.audioTracks() : []);
    };
    const offStatus = live.subscribe(feed);
    const offShoot = shoot.subscribe(feed);
    feed();
    return () => {
      offHeard();
      offMoves();
      offStatus();
      offShoot();
      live.listen([]);
    };
  }, [stream, on]);
}
