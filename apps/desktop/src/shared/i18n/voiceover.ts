// Voiceover dialog (renderer/src/components/VoiceoverDialog.tsx, voiceover/; ADR 0034 decision 22): progress and Cancel
// while generating, the misread report, and placing the takes on the timeline. The cost box is main's (`app.dialogs`).

const en = {
  title: (script: string) => `Voiceover of ${script}`,
  close: "Close",
  cancel: "Cancel",
  getting: "Getting ready…",
  confirmWait: "Waiting for you to confirm the cost…",
  saying: (line: string) => `Saying ${line}…`,
  checking: (line: string) => `Checking ${line} against the script…`,
  checkingAll: "Checking the takes against the script…",
  downloading: "Downloading the transcription tools, once…",
  working: "Working…",
  stop: "Stop",
  stopping: "Stopping…",
  nothingStopped: "There was nothing to stop yet. Try again in a moment.",
  stopped: (kept: number) =>
    kept === 0 ? "Stopped. Nothing was generated." : `Stopped. ${kept === 1 ? "1 take was" : `${kept} takes were`} saved and ${kept === 1 ? "is" : "are"} kept.`,
  failed: "The voiceover could not be generated",
  chooseTitle: "Check the takes against the script?",
  chooseBody: (megabytes: number) =>
    `Checking transcribes each take and compares it with its line, to catch what the voice misread. Transcription is not on this computer yet: it downloads about ${megabytes} MB, once.`,
  generateAndCheck: (megabytes: number) => `Generate and check (download ${megabytes} MB)`,
  generateOnly: "Generate without checking",
  summary: (generated: number, reused: number) =>
    `${generated === 1 ? "1 line was generated" : `${generated} lines were generated`}${reused > 0 ? ` and ${reused === 1 ? "1 was already there" : `${reused} were already there`}` : ""}. The takes are in assets/voiceover/.`,
  linesHeading: "Lines",
  state: { generated: "generated", cached: "already there", copied: "copied" },
  check: { clean: "Heard as written", doubtful: "Maybe the transcription", misread: "Misread", none: "Not checked" },
  checked: (misread: number, doubtful: number) =>
    misread === 0 && doubtful === 0
      ? "Every line was heard as written."
      : `${misread === 1 ? "1 line was misread" : `${misread} lines were misread`}, ${doubtful === 1 ? "1 may be the transcription's doing" : `${doubtful} may be the transcription's doing`}.`,
  notCheckedUnavailable: "Not checked against the script: this project has no transcription plugin the app can use (frameshell plugin install @frameshell/whisper-cpp).",
  notCheckedDeclined: "Not checked against the script: you skipped the transcription download.",
  notCheckedWhy: (reason: string) => `Not checked against the script: ${reason}`,
  misreadKind: {
    missing: "Not said",
    changed: "Said as other words",
    added: "Extra words",
    moved: "Out of place",
    restart: "Restarted",
    pause: "Long pause",
  },
  expected: "Script",
  heard: "Heard",
  maybeTranscription: "maybe the transcription",
  warningsHeading: "Notes",
  placeHeading: "Place on the timeline",
  placeHelp: "Puts the phrases of each line on the Voiceover track of the main timeline, in one step you can undo.",
  startLabel: "Start at",
  startPlaceholder: "seconds, a marker or beat:9",
  startHint: "Empty: right after the last voice clip. Seconds, a marker name, beat:N or bar:N (a name made only of digits counts as seconds).",
  replaceLabel: "Replace clips already placed from these takes",
  place: "Place",
  placing: "Placing…",
  placed: (phrases: number, lines: number, track: string) =>
    `Placed ${phrases === 1 ? "1 phrase" : `${phrases} phrases`} of ${lines === 1 ? "1 line" : `${lines} lines`} on ${track}.`,
  placeFailed: "Could not place the voiceover",
};

const es: typeof en = {
  title: (script) => `Voz en off de ${script}`,
  close: "Cerrar",
  cancel: "Cancelar",
  getting: "Preparando…",
  confirmWait: "Esperando que confirmes el costo…",
  saying: (line) => `Diciendo ${line}…`,
  checking: (line) => `Comprobando ${line} contra el guion…`,
  checkingAll: "Comprobando las tomas contra el guion…",
  downloading: "Descargando las herramientas de transcripción, una sola vez…",
  working: "Trabajando…",
  stop: "Detener",
  stopping: "Deteniendo…",
  nothingStopped: "Todavía no había nada que detener. Inténtalo de nuevo en un momento.",
  stopped: (kept) =>
    kept === 0 ? "Detenido. No se generó nada." : `Detenido. ${kept === 1 ? "1 toma se guardó" : `${kept} tomas se guardaron`} y ${kept === 1 ? "se conserva" : "se conservan"}.`,
  failed: "No se pudo generar la voz en off",
  chooseTitle: "¿Comprobar las tomas contra el guion?",
  chooseBody: (megabytes) =>
    `La comprobación transcribe cada toma y la compara con su línea, para detectar lo que la voz leyó mal. La transcripción aún no está en este equipo: se descargan unos ${megabytes} MB, una sola vez.`,
  generateAndCheck: (megabytes) => `Generar y comprobar (descargar ${megabytes} MB)`,
  generateOnly: "Generar sin comprobar",
  summary: (generated, reused) =>
    `${generated === 1 ? "Se generó 1 línea" : `Se generaron ${generated} líneas`}${reused > 0 ? ` y ${reused === 1 ? "1 ya estaba" : `${reused} ya estaban`}` : ""}. Las tomas están en assets/voiceover/.`,
  linesHeading: "Líneas",
  state: { generated: "generada", cached: "ya estaba", copied: "copiada" },
  check: { clean: "Se oyó como está escrita", doubtful: "Quizá la transcripción", misread: "Mal leída", none: "Sin comprobar" },
  checked: (misread, doubtful) =>
    misread === 0 && doubtful === 0
      ? "Todas las líneas se oyeron como están escritas."
      : `${misread === 1 ? "1 línea se leyó mal" : `${misread} líneas se leyeron mal`}, ${doubtful === 1 ? "1 puede ser culpa de la transcripción" : `${doubtful} pueden ser culpa de la transcripción`}.`,
  notCheckedUnavailable: "Sin comprobar contra el guion: este proyecto no tiene un plugin de transcripción que la app pueda usar (frameshell plugin install @frameshell/whisper-cpp).",
  notCheckedDeclined: "Sin comprobar contra el guion: omitiste la descarga de la transcripción.",
  notCheckedWhy: (reason) => `Sin comprobar contra el guion: ${reason}`,
  misreadKind: {
    missing: "No se dijo",
    changed: "Dicho con otras palabras",
    added: "Palabras de más",
    moved: "Fuera de lugar",
    restart: "Reiniciada",
    pause: "Pausa larga",
  },
  expected: "Guion",
  heard: "Se oyó",
  maybeTranscription: "quizá la transcripción",
  warningsHeading: "Notas",
  placeHeading: "Colocar en la línea de tiempo",
  placeHelp: "Pone las frases de cada línea en la pista Voiceover de la línea de tiempo principal, en un paso que puedes deshacer.",
  startLabel: "Empezar en",
  startPlaceholder: "segundos, un marcador o beat:9",
  startHint: "Vacío: justo después del último clip de voz. Segundos, el nombre de un marcador, beat:N o bar:N (un nombre hecho solo de dígitos cuenta como segundos).",
  replaceLabel: "Reemplazar los clips ya colocados con estas tomas",
  place: "Colocar",
  placing: "Colocando…",
  placed: (phrases, lines, track) =>
    `Se ${phrases === 1 ? "colocó 1 frase" : `colocaron ${phrases} frases`} de ${lines === 1 ? "1 línea" : `${lines} líneas`} en ${track}.`,
  placeFailed: "No se pudo colocar la voz en off",
};

/** English and Spanish strings of the voiceover dialog. */
export const voiceover = { en, es };
