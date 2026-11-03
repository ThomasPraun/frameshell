// Transcription model picker (#427) in the transcript toolbar (renderer/src/components/ModelPicker.tsx) and its
// file dialog (main/index.ts).

const en = {
  label: "Transcription model",
  title: "Model used to transcribe this project's media (frameshell transcribe). Saved in frameshell.json.",
  /** The project names no model: what is used instead. */
  defaultOption: (model: string | null) => (model ? `Default (${model})` : "Default"),
  providerGroup: (provider: string) => `${provider} models`,
  pinned: (id: string, size: string | null, downloaded: boolean) =>
    `${id}${size ? ` · ${size}` : ""}${downloaded ? "" : size ? ", downloads on first use" : " · downloads on first use"}`,
  registeredGroup: "Your model files",
  registered: (id: string, file: string) => `${id} · ${file}`,
  missingFile: " (file missing)",
  changedFile: " (file changed)",
  /** A project model this machine does not know: transcribing fails until it is registered. */
  unknown: (id: string) => `${id} (not on this machine)`,
  customFile: "Custom file…",
  megabytes: (mb: number) => `${mb} MB`,
  gigabytes: (gb: string) => `${gb} GB`,
  chooseFile: "Choose a model file",
  fileFilter: "Model files",
  register: "Register",
  cancel: "Cancel",
  idLabel: "Model name",
  idHint: "Letters, digits, dots, dashes and underscores. Projects name the model by it.",
  dtwLabel: "Trained from",
  dtwNone: "Unknown (coarser word timing)",
  optionNone: "None",
  dtwTitle: "The Whisper model this file was fine-tuned from: its alignment data gives precise word starts.",
  registerTitle: (file: string) => `Register ${file} on this computer`,
  using: (model: string) => `Transcription now uses ${model}.`,
  usingDefault: (model: string | null) => (model ? `Transcription now uses the default, ${model}.` : "Transcription now uses the default model."),
  notChanged: (message: string) => `Model not changed: ${message}`,
  notRegistered: (message: string) => `Model not registered: ${message}`,
  cannotList: (message: string) => `Models cannot be listed: ${message}`,
};

const es: typeof en = {
  label: "Modelo de transcripción",
  title: "Modelo con el que se transcriben los medios de este proyecto (frameshell transcribe). Se guarda en frameshell.json.",
  defaultOption: (model) => (model ? `Predeterminado (${model})` : "Predeterminado"),
  providerGroup: (provider) => `Modelos de ${provider}`,
  pinned: (id, size, downloaded) =>
    `${id}${size ? ` · ${size}` : ""}${downloaded ? "" : size ? ", se descarga al usarlo por primera vez" : " · se descarga al usarlo por primera vez"}`,
  registeredGroup: "Tus archivos de modelo",
  registered: (id, file) => `${id} · ${file}`,
  missingFile: " (falta el archivo)",
  changedFile: " (el archivo cambió)",
  unknown: (id) => `${id} (no está en esta computadora)`,
  customFile: "Archivo propio…",
  megabytes: (mb) => `${mb} MB`,
  gigabytes: (gb) => `${gb} GB`,
  chooseFile: "Elegir un archivo de modelo",
  fileFilter: "Archivos de modelo",
  register: "Registrar",
  cancel: "Cancelar",
  idLabel: "Nombre del modelo",
  idHint: "Letras, números, puntos, guiones y guiones bajos. Los proyectos nombran el modelo con él.",
  dtwLabel: "Entrenado a partir de",
  dtwNone: "Desconocido (tiempos de palabra menos precisos)",
  optionNone: "Ninguno",
  dtwTitle: "El modelo Whisper del que se ajustó este archivo: sus datos de alineación dan inicios de palabra precisos.",
  registerTitle: (file) => `Registrar ${file} en esta computadora`,
  using: (model) => `La transcripción ahora usa ${model}.`,
  usingDefault: (model) => (model ? `La transcripción ahora usa el predeterminado, ${model}.` : "La transcripción ahora usa el modelo predeterminado."),
  notChanged: (message) => `No se cambió el modelo: ${message}`,
  notRegistered: (message) => `No se registró el modelo: ${message}`,
  cannotList: (message) => `No se pueden listar los modelos: ${message}`,
};

/** Transcription model picker strings. */
export const models = { en, es };
