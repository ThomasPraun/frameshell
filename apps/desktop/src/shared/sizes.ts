/** `bytes` rounded for a person: `620 MB` below a gigabyte (at least `1 MB`), else `1.2 GB`. Decimal units. */
export function sizeText(bytes: number): string {
  return bytes < 1e9 ? `${Math.max(1, Math.round(bytes / 1e6))} MB` : `${(bytes / 1e9).toFixed(1)} GB`;
}

/** {@link sizeText} marked as approximate, for a download still to come: `~620 MB`, `~1.2 GB`. */
export function downloadSize(bytes: number): string {
  return `~${sizeText(bytes)}`;
}
