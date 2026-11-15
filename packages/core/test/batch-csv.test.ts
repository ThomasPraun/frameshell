import { describe, expect, it } from "vitest";
import { ErrorCode } from "@frameshell/protocol";
import type { Timeline } from "@frameshell/schema";
import { type CsvType, rowsFromCsv, templateColumnTypes } from "../src/batch/csv.js";

const slots = {
  title: "c_card.props.title",
  price: "c_card.props.price",
  sale: "c_card.props.sale",
  items: "c_card.props.items",
  note: "c_card.props.note",
  voice: "c_vo.asset",
  vo: "voiceover",
};

const template = {
  schemaVersion: 1,
  id: "main",
  revision: 1,
  tracks: [
    { id: "t_v", kind: "video", clips: [{ id: "c_card", type: "card", source: "x", start: 0, duration: 1, props: { title: "Launch", price: 9.5, sale: false, items: ["a"] } }] },
    { id: "t_a", kind: "audio", clips: [{ id: "c_vo", type: "media", asset: "assets/vo-en.wav", start: 0, in: 0, out: 1 }] },
  ],
} as unknown as Timeline;

const types = templateColumnTypes(template, slots);
const rows = (text: string) => rowsFromCsv(text, "/p/rows.csv", slots, types);
const problems = (text: string): string => {
  try {
    rows(text);
  } catch (error) {
    expect(error).toMatchObject({ code: ErrorCode.InvalidProjectFile });
    return (error as { data: { details: string } }).data.details;
  }
  throw new Error("expected the file to be refused");
};

describe("templateColumnTypes", () => {
  it("types a props slot by the template's value at its path, and leaves the rest untyped", () => {
    const found: [string, CsvType][] = [...types];
    expect(Object.fromEntries(found)).toEqual({ title: "text", price: "number", sale: "boolean", items: "json" });
  });
});

describe("rowsFromCsv", () => {
  it("reads rows typed by the template, with an empty cell leaving the slot to the template", () => {
    expect(rows("id,title,price,sale,voice\nes,Hola,12.5,true,assets/vo-es.wav\nfr,,10,no,\n")).toEqual([
      { id: "es", title: "Hola", price: 12.5, sale: true, voice: "assets/vo-es.wav" },
      { id: "fr", price: 10, sale: false },
    ]);
  });

  it("types a column by its header, which wins over the template and covers a prop the template lacks", () => {
    expect(rows('id,price:text,note:json,items:json,sale:boolean\nes,"9,50",{"a":1},"[1,2]",1\n')).toEqual([{ id: "es", price: "9,50", note: { a: 1 }, items: [1, 2], sale: true }]);
  });

  it("reads quoted cells with delimiters, doubled quotes and line breaks, CRLF line ends, a BOM and blank lines", () => {
    const text = '\uFEFFid,title\r\nes,"Hola, ""mundo"""\r\n\r\nfr,"two\nlines"\r\n';
    expect(rows(text)).toEqual([
      { id: "es", title: 'Hola, "mundo"' },
      { id: "fr", title: "two\nlines" },
    ]);
  });

  it("takes the delimiter the header uses: semicolon (Spanish spreadsheets) or tab", () => {
    expect(rows("id;title;price\nes;Hola, amigos;9.5\n")).toEqual([{ id: "es", title: "Hola, amigos", price: 9.5 }]);
    expect(rows("id\ttitle\nes\tHola, amigos\n")).toEqual([{ id: "es", title: "Hola, amigos" }]);
  });

  it("leaves a text cell as written but trims the others and the id", () => {
    expect(rows("id,title,price\n es , Hola ,  7 \n")).toEqual([{ id: "es", title: " Hola ", price: 7 }]);
  });

  it("reads the voiceover column as a script path", () => {
    expect(rows("id,vo\nes,scripts/launch-es.md\n")).toEqual([{ id: "es", vo: "scripts/launch-es.md" }]);
  });

  it("names the line and column of every wrong cell, in file order, and counts what it does not list", () => {
    const details = problems(
      [
        "id,title,price,sale,items,nope",
        "es,Hola,twelve,maybe,\"[1,,x\",",
        "ES,Hola,1,true,[],",
        "fr,Hola,1",
        "fr,Hola,1,true,[],",
        "fr,Hola,1,true,[],",
      ].join("\n"),
    );
    expect(details.split("\n")).toEqual([
      "line 1, column nope: unknown slot nope; the header is `id` and slot names (title, price, sale, items, note, voice, vo)",
      'line 2, column price: expected a number, got "twelve" (write price:text to read it as text)',
      'line 2, column sale: expected true, false, yes, no, 1 or 0, got "maybe" (write sale:text to read it as text)',
      expect.stringMatching(/^line 2, column items: expected JSON, got "\[1,,x": /),
      'line 3, column id: "ES" must be lowercase letters, digits and `-`, up to 64, e.g. `es` or `product-12`',
      "line 4: has 3 cells, the header has 6",
      "line 6, column id: row id fr is used twice (line 5); ids name output files",
    ]);
  });

  it("refuses a header without id, an empty or duplicated column, a type on an asset, and an unknown type", () => {
    expect(problems("title\nHola\n")).toContain("the header has no `id` column");
    expect(problems("id,,title\nes,x,y\n")).toContain("line 1, column 2: column 2 has no name");
    expect(problems("id,title,title\nes,x,y\n")).toContain("line 1, column title: title is a column twice");
    expect(problems("id,voice:number\nes,1\n")).toContain("line 1, column voice:number: voice is an asset slot: its cells are paths, so it takes no type but text");
    expect(problems("id,price:money\nes,1\n")).toContain("line 1, column price:money: unknown type money; use text, number, boolean or json");
    expect(problems("id:text,title\nes,x\n")).toContain("line 1, column id:text: `id` is the row id and takes no type");
  });

  it("refuses an empty file, a header alone, an unclosed quote and text after a closing quote", () => {
    expect(problems("")).toContain("line 1: the file is empty");
    expect(problems("id,title\n")).toContain("line 1: the file has a header and no rows");
    expect(problems('id,title\nes,"Hola\n')).toContain("line 2: a quoted cell opened here is never closed");
    expect(problems('id,title\nes,"Hola"x\n')).toContain("line 2: text after the closing quote of a cell");
  });

  it("lists the first 20 problems and counts the rest", () => {
    const text = `id,price\n${Array.from({ length: 25 }, (_, index) => `r${index},x`).join("\n")}\n`;
    const lines = problems(text).split("\n");
    expect(lines).toHaveLength(21);
    expect(lines.at(-1)).toBe("... and 5 more");
  });
});
