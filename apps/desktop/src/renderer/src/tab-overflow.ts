// A tab strip narrower than its tabs (#736): which tabs are out of view, so the strip can say there are more and a
// menu can reach them.

/** A tab's span along the strip, px, in the strip's scroll coordinates. */
export interface TabSpan {
  start: number;
  end: number;
}

/** What the strip shows of its tabs at scroll position `scroll` and width `width`, px. */
export interface Overflow {
  /** Tabs cut off before the visible part. */
  before: boolean;
  /** Tabs cut off after it. */
  after: boolean;
  /** Index of each tab not fully visible, in tab order. */
  hidden: number[];
}

/** A tab counts as visible with at most this many px cut off: a sub-pixel edge is not hidden. */
const SLACK = 2;

/** Which of `tabs` the strip leaves out of view. */
export function tabOverflow(tabs: readonly TabSpan[], scroll: number, width: number): Overflow {
  const hidden = tabs.flatMap((tab, index) => (tab.start < scroll - SLACK || tab.end > scroll + width + SLACK ? [index] : []));
  return {
    before: tabs.some((tab) => tab.start < scroll - SLACK),
    after: tabs.some((tab) => tab.end > scroll + width + SLACK),
    hidden,
  };
}
