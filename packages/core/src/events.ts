import type { EventName, EventParams } from "@frameshell/protocol";

/** Where a subscribed connection's notifications go. */
export interface EventSink {
  /** Send one notification. Must not throw; a closed connection drops it. */
  notify(method: EventName, params: unknown): void;
}

/**
 * Per-connection event subscriptions, scoped by project root
 * (`events.subscribe`). The daemon publishes here; only connections that
 * subscribed to that event on that project are notified.
 */
export class EventHub {
  readonly #subscriptions = new Map<EventSink, Map<string, Set<EventName>>>();

  /** Add `events` for `project` on `sink`; returns every event `sink` now receives for `project`. */
  subscribe(sink: EventSink, project: string, events: readonly EventName[]): EventName[] {
    let projects = this.#subscriptions.get(sink);
    if (!projects) this.#subscriptions.set(sink, (projects = new Map()));
    let names = projects.get(project);
    if (!names) projects.set(project, (names = new Set()));
    for (const event of events) names.add(event);
    return [...names].sort();
  }

  /** Remove `events` for `project` from `sink`; returns what `sink` still receives for `project`. */
  unsubscribe(sink: EventSink, project: string, events: readonly EventName[]): EventName[] {
    const names = this.#subscriptions.get(sink)?.get(project);
    if (!names) return [];
    for (const event of events) names.delete(event);
    return [...names].sort();
  }

  /** Forget every subscription of a closed connection. */
  drop(sink: EventSink): void {
    this.#subscriptions.delete(sink);
  }

  /** Notify every connection subscribed to `event` on `project`. */
  publish<E extends EventName>(event: E, project: string, params: EventParams<E>): void {
    for (const [sink, projects] of this.#subscriptions) {
      if (projects.get(project)?.has(event)) sink.notify(event, params);
    }
  }
}
