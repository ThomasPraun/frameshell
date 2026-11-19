// The consent gate of cloud and paid transcription (ADR 0046): `transcribe` asks before audio leaves the machine
// or costs money; every other caller loads its provider through `requireLocalTranscription` and never uploads.
import { createHash } from "node:crypto";
import type { TranscribeOptions, TranscriptionProvider } from "@frameshell/plugin-api";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import { formatCost } from "../cost.js";
import { pcmWavSeconds } from "./window.js";

/**
 * Provider ids that run on this machine for free whatever their plugin version: projects pin `whisper-cpp`
 * versions older than `TranscriptionProvider.free` (ADR 0046 decision 2).
 */
const LOCAL_ENGINES: ReadonlySet<string> = new Set(["whisper-cpp"]);

/** True when `provider` keeps the audio on this machine and never charges: the only kind background checks use. */
export function isLocalFreeTranscription(provider: TranscriptionProvider): boolean {
  if (provider.remote === true || provider.estimate) return false;
  return provider.free === true || LOCAL_ENGINES.has(provider.id);
}

/**
 * `provider` when it is local and free, else the refusal of a caller other than `transcribe` (ADR 0046 decision 8):
 * `TranscriptionFailed` naming `transcribe --yes` and a local provider. `asset` is what the caller was transcribing,
 * when there is one.
 */
export function requireLocalTranscription(provider: TranscriptionProvider, providerId: string, asset: string | null): TranscriptionProvider {
  if (isLocalFreeTranscription(provider)) return provider;
  const details =
    `${providerId} may send audio off this machine or cost money, so only \`frameshell transcribe --yes\` uses it, after the person confirms. ` +
    "Checks like this one use only a local free provider: pass `--provider whisper-cpp` where the command takes one, or set `transcription.provider` to a local one.";
  throw new RpcError(ErrorCode.TranscriptionFailed, details, { provider: providerId, asset, details });
}

/** What {@link confirmTranscription} checks: one asset's run as `transcribe` is about to start it. */
export interface TranscriptionRun {
  provider: TranscriptionProvider;
  providerId: string;
  /** Model asked for; null = the provider's default. */
  model: string | null;
  /** Project-relative asset. */
  asset: string;
  /** `sha256:<hex>` of the asset bytes. */
  assetHash: string;
  /** The WAV the provider would get (absolute); its length is read only for a provider that may be asked. */
  audio: string;
  options: TranscribeOptions;
  /** The person confirmed (`yes`). */
  yes: boolean;
  /** Token of the refusal the person confirmed; absent, `yes` confirms whatever the run costs. */
  confirmation?: string | undefined;
}

/**
 * Let the run go on, or throw `ConfirmationRequired` (not confirmed) or `ConfirmationStale` (confirmed for another
 * run) when the provider is paid, of unknown cost, or `remote`. Free local providers pass without a look at the
 * audio. Errors of `estimate` are thrown as they are: the caller reports them as the provider's failure.
 */
export async function confirmTranscription(run: TranscriptionRun): Promise<void> {
  const { provider, providerId } = run;
  if (isLocalFreeTranscription(provider)) return;
  const length = await pcmWavSeconds(run.audio);
  if (length === null) throw new Error(`${run.audio} is not a mono 16-bit PCM WAV`);
  const seconds = Math.round(length * 1000) / 1000;
  const priced = provider.estimate ? await provider.estimate({ seconds }, run.options) : null;
  const cost = priced ? { amount: Math.max(0, priced.cost), currency: priced.currency } : null;
  const remote = provider.remote === true;
  const unknownCost = !provider.estimate && provider.free !== true;
  if (!remote && !unknownCost && (cost === null || cost.amount === 0)) return;

  // What the person saw: the asset's content and the cost as printed. Not the audio source or exact length, which
  // change when an ingest finishes between the ask and the confirmed call (sidecar instead of the asset).
  const confirmation = createHash("sha256")
    .update(JSON.stringify([providerId, run.model, run.assetHash, cost ? formatCost(cost) : null]))
    .digest("hex")
    .slice(0, 32);
  const ask = { provider: providerId, model: run.model, asset: run.asset, seconds, cost, remote, confirmation };
  const heard = `${formatLength(seconds)} of audio`;
  const sent = remote
    ? `Transcribing ${run.asset} with ${providerId} uploads its audio (${heard}) to that service`
    : `Transcribing ${run.asset} with ${providerId} may send its audio (${heard}) off this machine`;
  const charged = (cost !== null && cost.amount > 0) || unknownCost;
  const price =
    cost !== null && cost.amount > 0
      ? ` and costs about ${formatCost(cost)}, plus short re-checks of over-long words. `
      : unknownCost
        ? " and may cost money: it gives no estimate and does not declare itself free. "
        : ". ";
  const message = sent + price;
  if (!run.yes) {
    throw new RpcError(
      ErrorCode.ConfirmationRequired,
      `${message}Ask the person to confirm the upload${charged ? " and the cost" : ""}, then call again with \`yes\` and this \`confirmation\` (CLI \`--yes\`).`,
      ask,
    );
  }
  if (run.confirmation !== undefined && run.confirmation !== confirmation) {
    const hint = "Show the person the new ask; pass the new `confirmation` with `yes`.";
    throw new RpcError(
      ErrorCode.ConfirmationStale,
      `The asset, its audio or the cost changed since the person confirmed: nothing was sent. ${message}${hint}`,
      { ...ask, hint },
    );
  }
}

/** `m:ss` (`h:mm:ss` from an hour), for the refusal message. */
function formatLength(seconds: number): string {
  const whole = Math.ceil(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
