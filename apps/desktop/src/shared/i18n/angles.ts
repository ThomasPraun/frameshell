// Multicam viewer panel (renderer/src/components/AngleViewer.tsx, angles/model.ts).

const en = {
  noGroup: "This timeline has no multicam program track. Create a group from per-person videos and its angles show here.",
  grid: "Angles at the playhead",
  tile: (number: number, name: string) => `Angle ${number}, ${name}`,
  inShot: "In the current shot",
  /** Tooltip of an angle tile; angles 1-9 have keys. */
  tileHint: (number: number, inShot: boolean) =>
    `${inShot ? "In the current shot. " : ""}Click to cut to this angle at the playhead, Shift+click to add it to the shot${number <= 9 ? ` (${number}; Shift+${number})` : ""}`,
  speaking: "Speaking",
  preparing: "Preparing the preview of this angle…",
  unavailable: "No picture for this angle.",
  hint: "Click an angle to cut to it at the playhead. Shift+click adds it to the shot.",
  noGap: "No shot at the playhead: clicking cuts nothing.",
  turnsFailed: (reason: string) => `Speaking marks unavailable: ${reason}`,
};

const es: typeof en = {
  noGroup: "Esta línea de tiempo no tiene una pista de programa multicámara. Crea un grupo a partir de videos por persona y sus ángulos aparecerán aquí.",
  grid: "Ángulos en el cabezal",
  tile: (number, name) => `Ángulo ${number}, ${name}`,
  inShot: "En el plano actual",
  tileHint: (number, inShot) =>
    `${inShot ? "En el plano actual. " : ""}Haz clic para cortar a este ángulo en el cursor de reproducción, Mayús+clic para sumarlo al plano${number <= 9 ? ` (${number}; Mayús+${number})` : ""}`,
  speaking: "Hablando",
  preparing: "Preparando la vista previa de este ángulo…",
  unavailable: "Este ángulo no tiene imagen.",
  hint: "Haz clic en un ángulo para cortar a él en el cabezal. Mayús+clic lo añade al plano.",
  noGap: "No hay un plano bajo el cabezal: el clic no corta nada.",
  turnsFailed: (reason) => `Marcas de quién habla no disponibles: ${reason}`,
};

export const angles = { en, es };
