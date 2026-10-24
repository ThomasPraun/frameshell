// Teleprompter panel (renderer/src/components/TeleprompterPanel.tsx, teleprompter/; ADR 0024).

const en = {
  script: "Shoot script",
  scene: "Scene",
  noScripts: "No shoot script yet. Ask the agent to write one in scripts/ from your script, marked shoot: true.",
  empty: "This shoot script has nothing to say yet.",
  unreadable: (reason: string) => `Could not read the shoot script: ${reason}`,
  smaller: "Smaller text",
  larger: "Larger text",
  smallerMark: "A−",
  largerMark: "A+",
  mirror: "Mirror",
  mirrorHint: "Flip the text left to right, for a beam-splitter prompter.",
  cues: "Cues",
  cuesHint: "Show the cues in the script. Free slots always show.",
  held: "Held",
  hold: "Hold",
  resume: "Resume",
  keys: "←/→ word · ↑/↓ line · Space hold",
  text: "Teleprompter text",
  free: "Free",
  open: "Open teleprompter",
};

const es: typeof en = {
  script: "Guion de rodaje",
  scene: "Escena",
  noScripts: "Todavía no hay guion de rodaje. Pídele al agente que escriba uno en scripts/ a partir de tu guion, marcado shoot: true.",
  empty: "Este guion de rodaje todavía no tiene nada que decir.",
  unreadable: (reason) => `No se pudo leer el guion de rodaje: ${reason}`,
  smaller: "Texto más pequeño",
  larger: "Texto más grande",
  smallerMark: "A−",
  largerMark: "A+",
  mirror: "Espejo",
  mirrorHint: "Invierte el texto de izquierda a derecha, para un teleprompter con espejo.",
  cues: "Indicaciones",
  cuesHint: "Muestra las indicaciones del guion. Los espacios libres se muestran siempre.",
  held: "En pausa",
  hold: "Pausar",
  resume: "Seguir",
  keys: "←/→ palabra · ↑/↓ línea · Espacio pausa",
  text: "Texto del teleprompter",
  free: "Libre",
  open: "Abrir teleprompter",
};

export const teleprompter = { en, es };
