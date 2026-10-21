// Layers panel of an image project, in place of the timeline (renderer/src/components/LayersPanel.tsx, ADR 0017).

const en = {
  list: "Layers, top first",
  show: "Show layers",
  hide: "Hide layers",
  empty: "No layers yet. Drop an image anywhere in the window, or ask your agent to add one.",
  emptyLayer: "Empty layer",
  /** A layer whose clip is a generated composition; slot: the clip type, e.g. `hyperframes`. */
  generated: (type: string) => `${type} composition`,
  nestedTimeline: "Nested timeline",
  rename: "Rename",
  renameLayer: (name: string) => `Rename layer ${name}`,
  moveUp: "Move up",
  moveDown: "Move down",
  remove: "Delete layer",
  failed: (message: string) => `Could not change the layer: ${message}`,
};

const es: typeof en = {
  list: "Capas, la de arriba primero",
  show: "Mostrar las capas",
  hide: "Ocultar las capas",
  empty: "Todavía no hay capas. Suelta una imagen en cualquier parte de la ventana o pídele a tu agente que agregue una.",
  emptyLayer: "Capa vacía",
  generated: (type) => `Composición ${type}`,
  nestedTimeline: "Línea de tiempo anidada",
  rename: "Renombrar",
  renameLayer: (name) => `Renombrar la capa ${name}`,
  moveUp: "Subir",
  moveDown: "Bajar",
  remove: "Borrar capa",
  failed: (message) => `No se pudo cambiar la capa: ${message}`,
};

export const layers = { en, es };
