import { execFile } from "node:child_process";
import type { CodecReport } from "@frameshell/protocol";

/** Outcome of running a process to completion. Non-zero exit is data, not an error. */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Process runner seam. Rejects only when the process cannot start
 * (missing file, no permission) or times out.
 */
export type Exec = (file: string, args: string[], options?: { timeoutMs?: number }) => Promise<ExecResult>;

/** {@link Exec} backed by `child_process.execFile`; no shell. */
export const execProcess: Exec = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: options.timeoutMs ?? 30_000, maxBuffer: 16 << 20, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
      },
    );
  });

/** What `ffmpeg` provides on this machine. */
export interface FfmpegProbe {
  version: string | null;
  codecs: CodecReport[];
  /** Actionable issues; empty when every required codec is present. */
  problems: string[];
}

interface CodecSpec {
  name: string;
  kind: "encoder" | "decoder";
  label: string;
  hardware: boolean;
  /** Why it is required; absent for optional (hardware) codecs. */
  requiredFor?: string;
}

/** Codecs `doctor` reports. Required ones come from SPEC §3.5 and ADR 0002. */
const CODECS: readonly CodecSpec[] = [
  { name: "libx264", kind: "encoder", label: "H.264 (x264)", hardware: false, requiredFor: "H.264 export and opaque clip renders" },
  { name: "libvpx-vp9", kind: "encoder", label: "VP9 (libvpx)", hardware: false, requiredFor: "VP9 renders with alpha" },
  {
    name: "libvpx-vp9",
    kind: "decoder",
    label: "VP9 with alpha (libvpx)",
    hardware: false,
    requiredFor: "decoding VP9 alpha clips; the native vp9 decoder drops alpha, so overlays would render opaque",
  },
  { name: "h264_videotoolbox", kind: "encoder", label: "H.264 (VideoToolbox)", hardware: true },
  { name: "hevc_videotoolbox", kind: "encoder", label: "HEVC (VideoToolbox)", hardware: true },
  { name: "h264_nvenc", kind: "encoder", label: "H.264 (NVENC)", hardware: true },
  { name: "hevc_nvenc", kind: "encoder", label: "HEVC (NVENC)", hardware: true },
  { name: "h264_vaapi", kind: "encoder", label: "H.264 (VAAPI)", hardware: true },
  { name: "hevc_vaapi", kind: "encoder", label: "HEVC (VAAPI)", hardware: true },
];

/** Standard render node; the one VAAPI uses when a machine has a single GPU. */
const VAAPI_DEVICE = "/dev/dri/renderD128";

/**
 * Probe an ffmpeg binary: version, compiled-in codecs, and a one-frame test
 * encode per compiled hardware encoder (compiled ≠ usable: NVENC needs an
 * NVIDIA GPU, VAAPI a render node). Never throws: an unrunnable binary is a problem.
 */
export async function probeFfmpeg(path: string, exec: Exec = execProcess): Promise<FfmpegProbe> {
  let listings: [ExecResult, ExecResult, ExecResult];
  try {
    listings = await Promise.all(
      ["-version", "-encoders", "-decoders"].map((flag) => exec(path, ["-hide_banner", flag])) as [
        Promise<ExecResult>,
        Promise<ExecResult>,
        Promise<ExecResult>,
      ],
    );
  } catch (error) {
    return { version: null, codecs: [], problems: [`Cannot run ${path}: ${(error as Error).message}`] };
  }
  const [version, encoders, decoders] = listings;
  const compiled = { encoder: codecNames(encoders.stdout), decoder: codecNames(decoders.stdout) };

  const codecs = await Promise.all(
    CODECS.map(async (spec): Promise<CodecReport> => {
      const isCompiled = compiled[spec.kind].has(spec.name);
      const works = spec.hardware && isCompiled ? await testEncode(path, spec.name, exec) : null;
      return { name: spec.name, kind: spec.kind, label: spec.label, hardware: spec.hardware, compiled: isCompiled, works };
    }),
  );
  const problems = CODECS.flatMap((spec, i) =>
    spec.requiredFor && !codecs[i]!.compiled
      ? [`${path} lacks the ${spec.name} ${spec.kind}, needed for ${spec.requiredFor}. Use the managed build or a GPL build with --enable-libx264 --enable-libvpx.`]
      : [],
  );
  return { version: parseVersion(version.stdout), codecs, problems };
}

/** Version token of `<tool> -version` (`ffmpeg version 9.0.2-… Copyright`), or null. */
export async function probeVersion(path: string, exec: Exec = execProcess): Promise<string | null> {
  try {
    return parseVersion((await exec(path, ["-hide_banner", "-version"])).stdout);
  } catch {
    return null;
  }
}

function parseVersion(output: string): string | null {
  return /^\S+ version (\S+)/m.exec(output)?.[1] ?? null;
}

/** Names from `-encoders` / `-decoders`: ` V....D libx264   description`. */
function codecNames(listing: string): Set<string> {
  const names = new Set<string>();
  for (const line of listing.split(/\r?\n/)) {
    const match = /^ [VAS][A-Z.]{5} (\S+)/.exec(line);
    if (match?.[1] && match[1] !== "=") names.add(match[1]);
  }
  return names;
}

async function testEncode(path: string, encoder: string, exec: Exec): Promise<boolean> {
  const vaapi = encoder.endsWith("_vaapi");
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    ...(vaapi ? ["-vaapi_device", VAAPI_DEVICE] : []),
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=256x256:rate=1",
    ...(vaapi ? ["-vf", "format=nv12,hwupload"] : []),
    "-frames:v",
    "1",
    "-c:v",
    encoder,
    "-f",
    "null",
    "-",
  ];
  try {
    return (await exec(path, args, { timeoutMs: 15_000 })).code === 0;
  } catch {
    return false;
  }
}
