// First-run checklist in the status bar of a project window (#787; renderer/src/components/FirstRun.tsx).

const en = {
  /** The status bar button. */
  button: (done: number, total: number) => `Getting started ${done}/${total}`,
  title: "Your first video",
  steps: {
    connect: "Connect your AI",
    footage: "Bring footage, or record in Shoot",
    cut: "Ask your AI for a cut, then correct it on the timeline",
    export: "Export the video",
  },
  done: "Done",
  /** Opens Connect your AI from the connect step. */
  connect: "Connect…",
  /** Opens the step's page on frameshell.dev. */
  howTo: "How",
  guide: "The whole guide",
  close: "Hide the checklist",
  guideUrl: "https://frameshell.dev/docs/first-video/",
  stepUrls: {
    connect: "https://frameshell.dev/docs/connect-your-ai/",
    footage: "https://frameshell.dev/docs/shoot/",
    cut: "https://frameshell.dev/docs/editing-by-hand/",
    export: "https://frameshell.dev/docs/export/",
  },
};

const es: typeof en = {
  button: (done, total) => `Primeros pasos ${done}/${total}`,
  title: "Tu primer video",
  steps: {
    connect: "Conecta tu IA",
    footage: "Trae tus videos o graba en Rodaje",
    cut: "Pídele un corte a tu IA y corrígelo en la línea de tiempo",
    export: "Exporta el video",
  },
  done: "Hecho",
  connect: "Conectar…",
  howTo: "Cómo",
  guide: "La guía completa",
  close: "Ocultar la lista",
  guideUrl: "https://frameshell.dev/es/docs/first-video/",
  stepUrls: {
    connect: "https://frameshell.dev/es/docs/connect-your-ai/",
    footage: "https://frameshell.dev/es/docs/shoot/",
    cut: "https://frameshell.dev/es/docs/editing-by-hand/",
    export: "https://frameshell.dev/es/docs/export/",
  },
};

export const firstRun = { en, es };
