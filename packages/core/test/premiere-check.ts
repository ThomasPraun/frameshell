/** A parsed xmeml element: the tests index into it freely. */
export interface XNode {
  name: string;
  attrs: Record<string, string>;
  kids: XNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (_all, name: string) => ENTITIES[name]!);
}

/** Parses well-formed XML (no comments, CDATA or processing instructions past the prolog); throws on anything else. */
export function parseXml(xml: string): XNode {
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, "").replace(/^<!DOCTYPE[^>]*>\s*/, "");
  const root: XNode = { name: "#root", attrs: {}, kids: [], text: "" };
  const stack: XNode[] = [root];
  const token = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/g;
  let last = 0;
  for (let match = token.exec(body); match !== null; match = token.exec(body)) {
    if (match.index !== last) throw new Error(`unparsable text at ${last}`);
    last = token.lastIndex;
    const [, closing, name, attrText, selfClosing, text] = match;
    const top = stack[stack.length - 1]!;
    if (text !== undefined) {
      if (/[<>]/.test(text) || /&(?!(amp|lt|gt|quot|apos);)/.test(text)) throw new Error(`bad text ${text}`);
      if (text.trim() !== "") top.text += decode(text);
      continue;
    }
    if (closing) {
      if (stack.length === 1 || top.name !== name) throw new Error(`mismatched </${name}>`);
      stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const attr of attrText!.matchAll(/([\w:.-]+)="([^"]*)"/g)) attrs[attr[1]!] = decode(attr[2]!);
    const node: XNode = { name: name!, attrs, kids: [], text: "" };
    top.kids.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (last !== body.length) throw new Error("trailing text");
  if (stack.length !== 1) throw new Error(`unclosed <${stack[stack.length - 1]!.name}>`);
  if (root.kids.length !== 1) throw new Error("not one root element");
  return root.kids[0]!;
}

/** Child elements of `node` called `name`. */
export function all(node: XNode, name: string): XNode[] {
  return node.kids.filter((kid) => kid.name === name);
}

/** The first child called `name`; throws when there is none. */
export function one(node: XNode, name: string): XNode {
  const found = all(node, name)[0];
  if (!found) throw new Error(`<${node.name}> has no <${name}>`);
  return found;
}

/** Text of the child called `name`. */
export function textOf(node: XNode, name: string): string {
  return one(node, name).text;
}

/** Every descendant (and `node` itself) called `name`, in document order. */
export function within(node: XNode, name: string): XNode[] {
  return [...(node.name === name ? [node] : []), ...node.kids.flatMap((kid) => within(kid, name))];
}

/** The tracks of `media` (`video` or `audio`) of the one sequence of an xmeml document. */
export function tracksOf(xmeml: XNode, media: "video" | "audio"): XNode[] {
  return all(one(one(one(xmeml, "sequence"), "media"), media), "track");
}

/**
 * What is wrong with an xmeml document, structurally: a `<file>` referenced before it is defined, a clip item whose
 * times are not whole frames, that ends before it starts or overlaps its neighbour, a transition that is not between two
 * clip items, a link that is not answered. Empty when the file is sound.
 */
export function premiereProblems(xml: string): string[] {
  const problems: string[] = [];
  let xmeml: XNode;
  try {
    xmeml = parseXml(xml);
  } catch (error) {
    return [`not well-formed: ${(error as Error).message}`];
  }
  if (xmeml.name !== "xmeml" || xmeml.attrs["version"] !== "4") problems.push("root is not <xmeml version=4>");
  const whole = (node: XNode, name: string, where: string) => {
    if (!/^-?\d+$/.test(textOf(node, name))) problems.push(`${where}: <${name}> ${textOf(node, name)} is not a whole number`);
  };

  const defined = new Set<string>();
  for (const file of within(xmeml, "file")) {
    const id = file.attrs["id"] ?? "";
    if (file.kids.length > 0) {
      if (defined.has(id)) problems.push(`file ${id} defined twice`);
      defined.add(id);
      if (all(file, "duration").length > 0) whole(file, "duration", `file ${id}`);
    } else if (!defined.has(id)) {
      problems.push(`file ${id} referenced before it is defined`);
    }
  }

  const items = new Map<string, XNode>();
  const positions = new Map<string, { media: string; track: number; index: number }>();
  for (const media of ["video", "audio"] as const) {
    tracksOf(xmeml, media).forEach((track, trackIndex) => {
      let end = -Infinity;
      let index = 0;
      let before: string | undefined;
      for (const kid of track.kids) {
        if (kid.name === "transitionitem") {
          if (before !== "clipitem") problems.push(`${media} track ${trackIndex + 1}: a transition does not follow a clipitem`);
          if (Number(textOf(kid, "start")) >= Number(textOf(kid, "end"))) problems.push(`${media} track ${trackIndex + 1}: transition ends before it starts`);
          before = "transitionitem";
          continue;
        }
        if (kid.name !== "clipitem") continue;
        before = "clipitem";
        index += 1;
        const id = kid.attrs["id"] ?? "";
        if (items.has(id)) problems.push(`clipitem ${id} twice`);
        items.set(id, kid);
        positions.set(id, { media, track: trackIndex + 1, index });
        for (const field of ["duration", "start", "end", "in", "out"]) whole(kid, field, id);
        const [start, finish] = [Number(textOf(kid, "start")), Number(textOf(kid, "end"))];
        if (!(start < finish)) problems.push(`${id}: ends (${finish}) before it starts (${start})`);
        if (start < end) problems.push(`${id}: overlaps the clip before it on its track`);
        end = Math.max(end, finish);
        if (!(Number(textOf(kid, "in")) < Number(textOf(kid, "out")))) problems.push(`${id}: out is not after in`);
        if (one(kid, "file").attrs["id"] === undefined) problems.push(`${id}: file has no id`);
      }
      if (before === "transitionitem") problems.push(`${media} track ${trackIndex + 1}: ends with a transition`);
    });
  }

  for (const [id, item] of items) {
    for (const link of all(item, "link")) {
      const ref = textOf(link, "linkclipref");
      const target = items.get(ref);
      const position = positions.get(ref);
      if (!target || !position) {
        problems.push(`${id}: link to missing ${ref}`);
        continue;
      }
      if (position.media !== textOf(link, "mediatype") || position.track !== Number(textOf(link, "trackindex")) || position.index !== Number(textOf(link, "clipindex"))) {
        problems.push(`${id}: link to ${ref} names the wrong place`);
      }
      if (!all(target, "link").some((back) => textOf(back, "linkclipref") === id)) problems.push(`${id}: ${ref} does not link back`);
    }
  }
  return problems;
}
