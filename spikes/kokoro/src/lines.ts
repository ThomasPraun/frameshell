// Test lines as a voiceover script holds them (display form, digits kept). The spoken form is what the
// pipeline hands a provider: digits spelled by the one number speller (`spellNumbersIn`, packages/schema).
import { built } from "./paths.ts";

export type Lang = "es" | "en";
export interface Line { id: string; lang: Lang; display: string }

const { spellNumbersIn } = await built<{ spellNumbersIn(text: string, language: Lang): string }>("packages/schema/dist/numbers.js");

/** What the voice reads. */
export function spoken(line: Line): string {
  return spellNumbersIn(line.display, line.lang);
}

/** Quality set: Spanish (numbers, accents, ñ, rr, loanwords, names) and English. */
export const QUALITY: Line[] = [
  { id: "es-01", lang: "es", display: "Hoy te muestro cómo editar un video en 3 minutos." },
  { id: "es-02", lang: "es", display: "El perro de Ramón corre por la carretera del cerro." },
  { id: "es-03", lang: "es", display: "La niña pequeña soñaba con una montaña y un año en España." },
  { id: "es-04", lang: "es", display: "¿Cuánto cuesta? Solo 25 dólares, o 1500 pesos mexicanos." },
  { id: "es-05", lang: "es", display: "Guillermo y Ximena llegaron a Oaxaca el 12 de octubre." },
  { id: "es-06", lang: "es", display: "Abre WhatsApp, entra a Instagram y comparte el link en YouTube." },
  { id: "es-07", lang: "es", display: "El murciélago hindú comía feliz cardillo y kiwi." },
  { id: "es-08", lang: "es", display: "Guerra, pingüino, agüita y guitarra: la ge suena distinta." },
  { id: "es-09", lang: "es", display: "Si quieres resultados, practica todos los días durante quince minutos." },
  { id: "es-10", lang: "es", display: "Frameshell edita el video mientras el agente trabaja en la terminal." },
  { id: "en-01", lang: "en", display: "Today I will show you how to edit a video in three minutes." },
  { id: "en-02", lang: "en", display: "The agent trims the pauses, and you correct the timeline." },
  { id: "en-03", lang: "en", display: "Download the model once, then everything runs offline on your laptop." },
  { id: "en-04", lang: "en", display: "It costs 25 dollars a month, or 240 dollars a year." },
  { id: "en-05", lang: "en", display: "Frameshell keeps every change in a journal you can undo." },
];

/** Speed set: about 3 s, 8 s and 20 s of speech, one English line, and a paragraph past one 510-token run. */
export const SPEED: Line[] = [
  { id: "s-03s", lang: "es", display: "Hola, bienvenidos a este tutorial." },
  {
    id: "s-08s",
    lang: "es",
    display: "En este video vamos a cortar las pausas largas y a dejar solo las mejores tomas del rodaje de ayer.",
  },
  {
    id: "s-20s",
    lang: "es",
    display:
      "Primero abrimos el proyecto y revisamos la transcripción. Después marcamos las frases que sobran, ajustamos " +
      "la música para que termine justo en el último corte y exportamos una versión vertical para redes sociales. " +
      "Al final revisamos los subtítulos.",
  },
  {
    id: "s-08s-en",
    lang: "en",
    display: "In this video we cut the long pauses and keep only the best takes from yesterday's shoot.",
  },
  {
    id: "s-long",
    lang: "es",
    display:
      "Este párrafo es largo a propósito. Sirve para comprobar qué pasa cuando el texto supera el límite de " +
      "quinientos diez símbolos que el modelo lee de una vez. El proveedor tiene que partirlo en frases, leer cada " +
      "parte por separado y unir el audio sin que se note el corte. Si la pausa entre partes suena natural, el " +
      "corte en el final de cada frase es suficiente. Si no, habrá que añadir un poco de silencio o un fundido corto. " +
      "También medimos cuánto tarda cada parte y cuánta memoria usa el proceso. Con eso sabremos si una línea larga " +
      "de guion cabe en el tiempo que una persona está dispuesta a esperar delante de la aplicación.",
  },
];
