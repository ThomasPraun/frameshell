// Live page URLs of generated clips (ADR 0010, 0011), shared by the live preview and the Pick tool. Main serves one
// URL per clip and revokes a clip's previous URL whenever it is asked again, so asking once per clip and render
// identity keeps a page that one user loaded alive while the other asks for it.

const pages = new Map<string, Promise<string>>();

/**
 * URL of `clip`'s live page on `timeline` for render `identity` (the render
 * key being rendered, or the ready render's file): asked of main once per
 * clip and identity, failures included, so a failing adapter is not asked
 * again until the clip changes. Rejects with the daemon's message.
 */
export function livePage(timeline: string, clip: string, identity: string): Promise<string> {
  const id = `${timeline}\0${clip}\0${identity}`;
  let page = pages.get(id);
  if (!page) {
    page = window.frameshell.clips.live(timeline, clip).then((live) => live.url);
    pages.set(id, page);
  }
  return page;
}

/** Forget every page: another project opened (same clip ids, other pages). */
export function forgetLivePages(): void {
  pages.clear();
}
