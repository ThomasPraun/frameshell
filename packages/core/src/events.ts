import type { EventName, EventParams } from "@frameshell/protocol";

/** Where a subscribed connection's notifications go. */
export interface EventSink {
  /** Send one notification. Must not throw; a closed connection drops it. */
  notify(method: EventName, params: unknown): void;
}

/** One connection's subscription to one project. */
interface Subscription {
  /** Project root as the connection named it; notifications carry it as `project`. */
  dir: string;
  names: Set<EventName>;
}

/**
 * Per-connection event subscriptions, scoped by project (`events.subscribe`).
 * Projects are matched by a canonical key (see `canonicalPath`), not by
 * spelling: the app, a terminal's CLI and the watcher may name one project
 * differently (symlinks, Windows 8.3 short names). Each connection gets
 * `project` spelled as it subscribed.
 */
export class EventHub {
  readonly #subscriptions = new Map<EventSink, Map<string, Subscription>>();

  /** Add `events` for project `key` (named `dir` by the client) on `sink`; returns every event `sink` now receives for it. */
  subscribe(sink: EventSink, key: string, dir: string, events: readonly EventName[]): EventName[] {
    let projects = this.#subscriptions.get(sink);
    if (!projects) this.#subscriptions.set(sink, (projects = new Map()));
    let subscription = projects.get(key);
    if (!subscription) projects.set(key, (subscription = { dir, names: new Set() }));
    subscription.dir = dir;
    for (const event of events) subscription.names.add(event);
    return [...subscription.names].sort();
  }

  /** Remove `events` for project `key` from `sink`; returns what `sink` still receives for it. */
  unsubscribe(sink: EventSink, key: string, events: readonly EventName[]): EventName[] {
    const names = this.#subscriptions.get(sink)?.get(key)?.names;
    if (!names) return [];
    for (const event of events) names.delete(event);
    return [...names].sort();
  }

  /** Forget every subscription of a closed connection. */
  drop(sink: EventSink): void {
    this.#subscriptions.delete(sink);
  }

  /** Notify every connection subscribed to `event` on project `key`, with `project` spelled as each subscribed. */
  publish<E extends EventName>(event: E, key: string, params: EventParams<E>): void {
    for (const [sink, projects] of this.#subscriptions) {
      const subscription = projects.get(key);
      if (subscription?.names.has(event)) sink.notify(event, { ...params, project: subscription.dir });
    }
  }
}
