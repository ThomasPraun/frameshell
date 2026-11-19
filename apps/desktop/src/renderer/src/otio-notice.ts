// File > Export OpenTimelineIO (ADR 0045): the notice shown once the daemon has written the file.

/** The wording {@link otioNotice} picks from (`t.workspace`). */
export interface OtioNoticeText {
  otioExported(name: string): string;
  otioExportedWith(name: string, count: number): string;
}

/** What the notice says of an export: the file's name, and how many things the file leaves out when there are any. */
export function otioNotice(result: { path: string; warnings: readonly string[] }, said: OtioNoticeText): string {
  const name = result.path.split(/[\\/]/).pop() ?? result.path;
  return result.warnings.length === 0 ? said.otioExported(name) : said.otioExportedWith(name, result.warnings.length);
}
