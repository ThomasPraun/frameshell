import { type AgentReference, type AgentTarget, type AgentTargetKind, ErrorCode, RpcError, clientAgentLabel } from "@frameshell/protocol";

// Agent targets and their inboxes (ADR 0025 decisions 3-4). A target is one client (an MCP client, `frameshell ask
// --wait`) on one project: every connection registering the same client name there shares its id and inbox, so the
// first one to read takes what waits. References live in memory only, until read; a target whose connections all
// closed is kept while references still wait for it, so a hook or a later session can take them.

/** What registers a target: a daemon connection, compared by identity. */
export type TargetOwner = object;

/** What a target registers with. */
export interface TargetRegistration {
  client: string;
  title?: string | undefined;
  kind: AgentTargetKind;
}

/** Options for {@link AgentTargets}. */
export interface AgentTargetsOptions {
  /**
   * Called after every change of project `key`'s targets, with all of them; `read` is the id of a target whose
   * references were just taken, else null.
   */
  onChanged?(key: string, targets: AgentTarget[], read: string | null): void;
  /** Clock for `sentAt`. Default `() => new Date()`. */
  now?: () => Date;
}

interface Target {
  id: string;
  kind: AgentTargetKind;
  client: string;
  title: string | null;
  owners: Set<TargetOwner>;
  pending: AgentReference[];
}

interface Waiter {
  owner: TargetOwner;
  key: string;
  id: string;
  deliver(references: AgentReference[]): void;
}

/** Target id of a client name: its agent label (`claude-code` → `claude`), the label its app terminals get too. */
export function targetId(client: string): string {
  return clientAgentLabel(client) ?? "agent";
}

/** Registry of the agent targets of every project and their inboxes; projects keyed by canonical root. */
export class AgentTargets {
  readonly #projects = new Map<string, Map<string, Target>>();
  /** Target id each owner registered as, per project key. */
  readonly #registrations = new Map<TargetOwner, Map<string, string>>();
  readonly #waiters: Waiter[] = [];
  readonly #onChanged: AgentTargetsOptions["onChanged"];
  readonly #now: () => Date;

  constructor(options: AgentTargetsOptions = {}) {
    this.#onChanged = options.onChanged;
    this.#now = options.now ?? (() => new Date());
  }

  /** Make `owner` target `registration` of project `key`, replacing a registration it held there. */
  register(owner: TargetOwner, key: string, registration: TargetRegistration): AgentTarget {
    const id = targetId(registration.client);
    const previous = this.#registrations.get(owner)?.get(key);
    if (previous !== undefined && previous !== id) this.#leave(owner, key, previous);
    let targets = this.#projects.get(key);
    if (!targets) this.#projects.set(key, (targets = new Map()));
    let target = targets.get(id);
    if (!target) {
      target = { id, kind: registration.kind, client: registration.client, title: registration.title ?? null, owners: new Set(), pending: [] };
      targets.set(id, target);
    }
    if (registration.title && !target.title) target.title = registration.title;
    target.owners.add(owner);
    let mine = this.#registrations.get(owner);
    if (!mine) this.#registrations.set(owner, (mine = new Map()));
    mine.set(key, id);
    this.#changed(key, null);
    return info(target);
  }

  /** `owner` stops being a target of project `key`. */
  unregister(owner: TargetOwner, key: string): void {
    const id = this.#registrations.get(owner)?.get(key);
    if (id === undefined) return;
    this.#leave(owner, key, id);
    this.#changed(key, null);
  }

  /** Forget everything `owner` registered or waits for: its connection closed. */
  drop(owner: TargetOwner): void {
    for (let i = this.#waiters.length - 1; i >= 0; i--) if (this.#waiters[i]!.owner === owner) this.#waiters.splice(i, 1);
    const mine = this.#registrations.get(owner);
    if (!mine) return;
    for (const [key, id] of [...mine]) {
      this.#leave(owner, key, id);
      this.#changed(key, null);
    }
  }

  /** Targets of project `key`, sorted by id. */
  list(key: string): AgentTarget[] {
    return [...(this.#projects.get(key)?.values() ?? [])].map(info).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Target id `owner` registered as on project `key`; null when none. */
  targetOf(owner: TargetOwner, key: string): string | null {
    return this.#registrations.get(owner)?.get(key) ?? null;
  }

  /** True when project `key` has target `id`. */
  has(key: string, id: string): boolean {
    return this.#projects.get(key)?.has(id) ?? false;
  }

  /**
   * Send `lines` to target `id` of project `key`: straight to its oldest waiter (`read`), else into its inbox. Throws
   * {@link RpcError} `InvalidParams` naming the targets when `id` is unknown.
   */
  put(key: string, id: string, lines: string[]): { target: AgentTarget; read: boolean } {
    const target = this.#projects.get(key)?.get(id);
    if (!target) {
      const known = this.list(key).map((each) => each.id);
      throw new RpcError(
        ErrorCode.InvalidParams,
        `No agent target \`${id}\` in this project; ${known.length > 0 ? `targets: ${known.join(", ")}` : "none is registered"}.`,
        { issues: [{ path: ["target"], message: "unknown target" }], targets: known },
      );
    }
    const reference = { lines: [...lines], sentAt: this.#now().toISOString() };
    const waiter = this.#waiters.findIndex((each) => each.key === key && each.id === id);
    if (waiter >= 0) {
      const [first] = this.#waiters.splice(waiter, 1);
      first!.deliver([reference]);
      this.#changed(key, id);
      return { target: info(target), read: true };
    }
    target.pending.push(reference);
    this.#changed(key, null);
    return { target: info(target), read: false };
  }

  /** Take every reference waiting for target `id` of project `key`, oldest first; empty when none or no such target. */
  take(key: string, id: string): AgentReference[] {
    const targets = this.#projects.get(key);
    const target = targets?.get(id);
    if (!target || target.pending.length === 0) return [];
    const taken = target.pending.splice(0);
    if (target.owners.size === 0) targets!.delete(id);
    this.#prune(key);
    this.#changed(key, id);
    return taken;
  }

  /**
   * {@link take}, but when nothing waits, wait for the next reference sent to `id` (handed to the oldest waiter of
   * the target), or resolve empty after `timeoutMs` or when `owner` is {@link drop}ped.
   */
  wait(owner: TargetOwner, key: string, id: string, timeoutMs: number): Promise<AgentReference[]> {
    const ready = this.take(key, id);
    if (ready.length > 0) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const at = this.#waiters.indexOf(waiter);
        if (at >= 0) this.#waiters.splice(at, 1);
        resolve([]);
      }, timeoutMs);
      timer.unref?.();
      const waiter: Waiter = {
        owner,
        key,
        id,
        deliver: (references) => {
          clearTimeout(timer);
          resolve(references);
        },
      };
      this.#waiters.push(waiter);
    });
  }

  #leave(owner: TargetOwner, key: string, id: string): void {
    const mine = this.#registrations.get(owner);
    mine?.delete(key);
    if (mine?.size === 0) this.#registrations.delete(owner);
    const targets = this.#projects.get(key);
    const target = targets?.get(id);
    if (!target) return;
    target.owners.delete(owner);
    if (target.owners.size === 0 && target.pending.length === 0) targets!.delete(id);
    this.#prune(key);
  }

  #prune(key: string): void {
    if (this.#projects.get(key)?.size === 0) this.#projects.delete(key);
  }

  #changed(key: string, read: string | null): void {
    this.#onChanged?.(key, this.list(key), read);
  }
}

function info(target: Target): AgentTarget {
  return {
    id: target.id,
    kind: target.kind,
    client: target.client,
    title: target.title,
    connections: target.owners.size,
    pending: target.pending.length,
  };
}
