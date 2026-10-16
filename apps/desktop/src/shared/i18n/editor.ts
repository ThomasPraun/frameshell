// Editor tabs, script scene hovers, file explorer (EditorArea, Explorer).

const en = {
  openFiles: "Open files",
  closeTab: (name: string) => `Close ${name}`,
  closeTabUnsaved: (path: string) => `Close ${path} (unsaved)`,
  showTranscript: (shortcut: string) => `Show the transcript of the timeline's media (${shortcut})`,
  noEditor: "This file type has no editor. Media plays in the preview.",
  discard: (path: string) => `Discard unsaved changes to ${path}?`,
  diskChanged: "This file changed on disk while you were editing.",
  diskDeleted: "This file was deleted on disk. Saving recreates it.",
  loadDisk: "Load disk version",
  notSaved: (reason: string) => `Not saved: ${reason}`,
  emptyOpen: (shortcut: string) => `Open a script or JSON file from the explorer, or the transcript (${shortcut}).`,
  emptyHint: "Saved files go through frameshelld, so the agent sees your edits right away.",
  wholeScriptLinked: (count: number, clips: string) =>
    `${count} ${count === 1 ? "clip" : "clips"} linked to the whole script (${clips}). Click to select ${count === 1 ? "it" : "them"}.`,
  sceneLinked: (slug: string, count: number, clips: string) =>
    `Scene \`#${slug}\`: ${count} ${count === 1 ? "clip" : "clips"} (${clips}). Click the heading to select ${count === 1 ? "it" : "them"}.`,
  sceneUnlinked: (slug: string) =>
    `Scene \`#${slug}\` has no clips yet. Link one with \`frameshell clip set <clip> --script-ref <script>#${slug}\`.`,
  folderEmpty: "This folder is empty.",
  projectFiles: "Project files",
};

const es: typeof en = {
  openFiles: "Archivos abiertos",
  closeTab: (name) => `Cerrar ${name}`,
  closeTabUnsaved: (path) => `Cerrar ${path} (sin guardar)`,
  showTranscript: (shortcut) => `Mostrar la transcripción de los medios de la línea de tiempo (${shortcut})`,
  noEditor: "Este tipo de archivo no tiene editor. Los medios se reproducen en la vista previa.",
  discard: (path) => `¿Descartar los cambios sin guardar de ${path}?`,
  diskChanged: "Este archivo cambió en el disco mientras lo editabas.",
  diskDeleted: "Este archivo se eliminó del disco. Al guardar se vuelve a crear.",
  loadDisk: "Cargar la versión del disco",
  notSaved: (reason) => `No se guardó: ${reason}`,
  emptyOpen: (shortcut) => `Abre un guion o un archivo JSON desde Archivos, o la transcripción (${shortcut}).`,
  emptyHint: "Los archivos guardados pasan por frameshelld, así que el agente ve tus cambios al instante.",
  wholeScriptLinked: (count, clips) =>
    `${count === 1 ? "1 clip vinculado" : `${count} clips vinculados`} a todo el guion (${clips}). Haz clic para seleccionar${count === 1 ? "lo" : "los"}.`,
  sceneLinked: (slug, count, clips) =>
    `Escena \`#${slug}\`: ${count} ${count === 1 ? "clip" : "clips"} (${clips}). Haz clic en el encabezado para seleccionar${count === 1 ? "lo" : "los"}.`,
  sceneUnlinked: (slug) =>
    `La escena \`#${slug}\` aún no tiene clips. Vincula uno con \`frameshell clip set <clip> --script-ref <script>#${slug}\`.`,
  folderEmpty: "Esta carpeta está vacía.",
  projectFiles: "Archivos del proyecto",
};

export const editor = { en, es };
