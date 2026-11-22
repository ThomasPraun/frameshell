import { describe, expect, it } from "vitest";
import { guessLanguage } from "../src/shoot/language.js";

const words = (text: string) => text.split(/\s+/);

describe("guessLanguage (#742)", () => {
  it("tells a Spanish script from an English one", () => {
    expect(guessLanguage(words("Hola a todos y bienvenidos al canal. Hoy hablamos de la cafetería del barrio, que abrió hace un año y es muy querida."))).toBe("es");
    expect(guessLanguage(words("Hello everyone and welcome to the channel. Today we talk about the coffee shop on your street, and what it is like."))).toBe("en");
  });

  it("makes no guess from a few words or a mix", () => {
    expect(guessLanguage(words("Hola a todos"))).toBeNull();
    expect(guessLanguage(words("Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt"))).toBeNull();
  });
});
