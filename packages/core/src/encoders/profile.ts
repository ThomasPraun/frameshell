import { availableParallelism, totalmem } from "node:os";
import type { MachineProfile } from "@frameshell/protocol";
import { videoToolboxKbps } from "./tiers.js";

/** What {@link machineProfile} reads about the machine; injected in tests. */
export interface MachineFacts {
  cpuCores: number;
  memoryBytes: number;
  /** A hardware encoder (VideoToolbox, NVENC) passed its test encode. */
  hardwareEncoder: boolean;
}

/** The running machine's facts; `hardwareEncoder` comes from the encoder probe. */
export function readMachineFacts(hardwareEncoder: boolean): MachineFacts {
  return { cpuCores: availableParallelism(), memoryBytes: totalmem(), hardwareEncoder };
}

/** Sizes in px of the short side, per class: faster machines keep sharper proxies and drafts. */
const SIZES = {
  fast: { proxy: 720, draft: 1080 },
  medium: { proxy: 540, draft: 720 },
  slow: { proxy: 360, draft: 540 },
} as const;

const GIB = 1024 ** 3;

/**
 * Speed class: a working hardware encoder with 8 cores or more, or 12 cores, is fast; under 4 cores or
 * 8 GiB of memory (with no hardware encoder) is slow; the rest medium. Coarse on purpose: it picks a size, not a benchmark.
 */
export function machineProfile(
  facts: MachineFacts,
  project: { resolution: { width: number; height: number }; fps: number },
): MachineProfile {
  const { cpuCores, memoryBytes, hardwareEncoder } = facts;
  const fast = (hardwareEncoder && cpuCores >= 8) || cpuCores >= 12;
  const slow = !fast && !hardwareEncoder && (cpuCores < 4 || memoryBytes < 8 * GIB);
  const speed = fast ? "fast" : slow ? "slow" : "medium";
  const { resolution, fps } = project;
  // Constant bitrate of a master, the upper bound of what an x264 CRF 16 master takes.
  const kbps = videoToolboxKbps("master", { ...resolution, fps });
  return {
    class: speed,
    cpuCores,
    memoryGb: Math.round((memoryBytes / GIB) * 10) / 10,
    proxyShortSide: SIZES[speed].proxy,
    draftShortSide: SIZES[speed].draft,
    resolution,
    fps,
    masterMbPerMinute: Math.round((kbps * 60) / 8 / 1000),
  };
}
