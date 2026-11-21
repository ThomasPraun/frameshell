// Audition dialog (renderer/src/components/AuditionDialog.tsx, audition/; ADR 0038): sound files side by side with a
// player, a spectrogram and their loudness, opened from the Explorer and from music candidate tracks.

const en = {
  title: (count: number) => (count === 1 ? "Listen" : `Audition ${count} sounds`),
  explorerItem: (count: number) => (count === 1 ? "Listen…" : `Audition ${count} sounds…`),
  folderItem: (count: number) => `Audition the ${count} sounds here…`,
  candidatesItem: (count: number) => `Audition the ${count} music candidates…`,
  reading: "Reading the sounds…",
  failed: "The sounds could not be read",
  matchLabel: "Match loudness",
  matchOn: (target: string) => `Every sound plays at ${target} LUFS, the level of the quietest one.`,
  matchOff: "Every sound plays as recorded.",
  matchNone: "No sound has a loudness to match.",
  play: (name: string) => `Play ${name}`,
  stop: (name: string) => `Stop ${name}`,
  preparing: "Still being prepared for playback…",
  notPlayed: (reason: string) => `Could not play the sound: ${reason}`,
  lufs: (value: string) => `${value} LUFS`,
  peak: (value: string) => `peak ${value} dBTP`,
  silent: "Silent",
  gain: (db: string) => `${db} dB`,
  sfxTake: (kind: string, variant: number, seed: number) => `${kind} · variant ${variant} · seed ${seed}`,
  musicTake: (preset: string, bpm: number, seed: number) => `${preset} · ${bpm} BPM · seed ${seed}`,
  spectrogram: (name: string) => `Spectrogram of ${name}`,
  /** Selects the file in the Explorer: named for what it does (#757: "Use this" placed nothing). */
  use: "Show in Explorer",
  useHint: "Selects the file in the Explorer and closes the dialog",
  seekHint: "Click to play from here",
  skipped: (name: string, reason: string) => `${name} was left out: ${reason}`,
  close: "Close",
};

const es: typeof en = {
  title: (count) => (count === 1 ? "Escuchar" : `Escuchar ${count} sonidos`),
  explorerItem: (count) => (count === 1 ? "Escuchar…" : `Escuchar ${count} sonidos…`),
  folderItem: (count) => `Escuchar los ${count} sonidos de aquí…`,
  candidatesItem: (count) => `Escuchar las ${count} músicas candidatas…`,
  reading: "Leyendo los sonidos…",
  failed: "No se pudieron leer los sonidos",
  matchLabel: "Igualar volumen",
  matchOn: (target) => `Todos los sonidos suenan a ${target} LUFS, el nivel del más bajo.`,
  matchOff: "Cada sonido suena como fue grabado.",
  matchNone: "Ningún sonido tiene un volumen para igualar.",
  play: (name) => `Reproducir ${name}`,
  stop: (name) => `Detener ${name}`,
  preparing: "Todavía se está preparando para reproducir…",
  notPlayed: (reason) => `No se pudo reproducir el sonido: ${reason}`,
  lufs: (value) => `${value} LUFS`,
  peak: (value) => `pico ${value} dBTP`,
  silent: "Silencio",
  gain: (db) => `${db} dB`,
  sfxTake: (kind, variant, seed) => `${kind} · variante ${variant} · semilla ${seed}`,
  musicTake: (preset, bpm, seed) => `${preset} · ${bpm} BPM · semilla ${seed}`,
  spectrogram: (name) => `Espectrograma de ${name}`,
  use: "Mostrar en el Explorador",
  useHint: "Selecciona el archivo en el Explorador y cierra el diálogo",
  seekHint: "Haz clic para reproducir desde aquí",
  skipped: (name, reason) => `${name} quedó fuera: ${reason}`,
  close: "Cerrar",
};

/** Strings of the Audition dialog, both languages. */
export const audition = { en, es };
