// A web address the person typed, for the idea form (renderer) and its check (main): one rule for both.

/** `text` with `https://` in front when it reads as a bare host and path (`www.example.com`, `example.com/a`); else as given. */
export function withScheme(text: string): string {
  return /^[a-z][a-z0-9+-]*:/i.test(text) || !/^[^\s/]+\.[a-z]{2,}(?:[/:?#]\S*)?$/i.test(text) ? text : `https://${text}`;
}
