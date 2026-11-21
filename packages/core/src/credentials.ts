/** Secrets the app may hand the daemon (ADR 0048): the environment variable each stands for. */
export type CredentialName = "OPENAI_API_KEY";

/** Where the daemon takes a secret from now. */
export type CredentialSource = "environment" | "app" | "none";

/**
 * Secrets handed over with `credentials.provide` (ADR 0048), kept only in `env` (the daemon's own environment, which
 * the plugins read at each call) while the connection that gave them is open. A variable already set when the
 * daemon started wins: it is never overwritten or removed. Never logs, journals or returns a value.
 */
export class ProvidedCredentials<Owner> {
  /** Variables the daemon's environment had at start; those are never touched. */
  readonly #fromEnvironment = new Set<CredentialName>();
  readonly #owners = new Map<CredentialName, Owner>();

  /** `env` is mutated in place: the daemon passes `process.env`, tests a plain object. */
  constructor(private readonly env: Record<string, string | undefined>, names: readonly CredentialName[] = ["OPENAI_API_KEY"]) {
    for (const name of names) if ((env[name] ?? "").trim() !== "") this.#fromEnvironment.add(name);
  }

  /** Set `name` to `value` on behalf of `owner`, or forget it with null (only the owner's own). */
  provide(name: CredentialName, value: string | null, owner: Owner): CredentialSource {
    if (this.#fromEnvironment.has(name)) return "environment";
    if (value === null) {
      if (this.#owners.get(name) === owner) this.#forget(name);
    } else {
      this.env[name] = value;
      this.#owners.set(name, owner);
    }
    return this.#owners.has(name) ? "app" : "none";
  }

  /** Forget every secret `owner` gave: its connection closed. */
  drop(owner: Owner): void {
    for (const [name, holder] of this.#owners) if (holder === owner) this.#forget(name);
  }

  #forget(name: CredentialName): void {
    delete this.env[name];
    this.#owners.delete(name);
  }
}
