// Timeline panel: header, zoom toolbar, track heads, tooltips, status lines, canvas texts (TimelinePanel, timeline/paint, timeline/layout).

const en = {
  showTimeline: "Show timeline",
  hideTimeline: "Hide timeline",
  showTranscript: "Show transcript",
  transcriptTitle: (shortcut: string) => `Open the transcript view (${shortcut})`,
  rejected: (timeline: string, reason: string, preserved: string, message: string) =>
    `Edit of timelines/${timeline}.json rejected (${reason}); the timeline was restored. ` +
    `Your version is kept at ${preserved}.\n${message}`,
  dismiss: "Dismiss",
  /** Slot: `{assets}`, the `assets/` folder name. */
  emptyHint: "Ask the agent in the terminal to cut your footage, or drop media into {assets}.",
  keysLabel: (mac: boolean) => {
    const mod = mac ? "Command" : "Control";
    return (
      `Timeline lanes. Click selects a clip, Shift or ${mod}+click adds or removes one, ${mod}+A selects all; ` +
      "drag moves the selected clips, drag an edge to trim (Shift when pressing it, or R, ripple trims: later clips follow); " +
      "drag over empty space selects a time range; the ruler moves the playhead. " +
      "Click a subtitle cue to select its words, or a subtitle lane to set its style. " +
      "S splits at the playhead, [ and ] trim to it, comma and period nudge a frame, Delete removes, Shift+Delete ripple deletes, " +
      "arrows move the playhead, N toggles snapping, Escape clears. Plus and minus zoom, 0 fits the timeline. " +
      `${mod}+Z undoes, ${mac ? "Command+Shift+Z" : "Control+Y"} redoes, also from the Edit menu.`
    );
  },
  nothingToUndo: "Nothing to undo",
  nothingToRedo: "Nothing to redo",
  addTrackFirst: "Add a video or audio track first: subtitles follow one",
  notMoved: (count: number) => `Not moved: ${count} clips would overlap a clip that stays`,
  roughSnap: (window: number, time: string) => `No pause within ${window} s of ${time}: speech may be clipped there`,
  edgeSnapped: (duration: string) => `Edge snapped ${duration} into a pause`,
  saved: (label: string) => `${label} saved`,
  savedMany: (label: string, count: number) => `${label} of ${count} clips saved as one step`,
  ops: {
    move: "Move",
    trim: "Trim",
    split: "Split",
    remove: "Delete",
    cut: "Ripple delete",
    revert: "Undo",
    trackAdd: "New track",
    trackSet: "Track change",
    paint: "Painted turns",
  },
  noSelectedUnderPlayhead: "No selected clip under the playhead",
  noClipUnderPlayhead: "No clip under the playhead",
  nothingToChange: "Nothing to change",
  selectClipFirst: "Select a clip first",
  zoomGroup: "Timeline zoom and snapping",
  zoomOut: "Zoom out",
  zoomOutTitle: "Zoom out (-)",
  zoomFit: "Zoom to fit",
  zoomFitTitle: "Zoom to fit (0)",
  zoomIn: "Zoom in",
  zoomInTitle: "Zoom in (+)",
  snapping: "Snapping",
  snappingTitle: (mac: boolean) => `Snap to clip edges and the playhead (N; hold ${mac ? "Option" : "Alt"} to invert)`,
  rippleTrim: "Ripple trim",
  rippleTrimTitle: "Ripple trim: edge drags move later clips along, leaving no gap (R; hold Shift when pressing an edge to invert)",
  addSubtitleTrack: "Add subtitle track",
  addSubtitleTitle: "Add subtitles: the transcript words of the selected clip's track (or the first transcribed one)",
  subtitleHeadTitle: (id: string) => `${id}: select to set its style`,
  programHeadTitle: (id: string) => `${id}: select to edit its angles`,
  wordsOf: (label: string) => `Words of ${label}`,
  changesOf: (target: string) => `Changes of ${target}`,
  diffKinds: { added: "added", removed: "removed", moved: "moved", changed: "changed" },
  stopShowing: "Stop showing these changes",
  stopShowingTitle: "Stop showing these changes (Esc on the lanes)",
  range: (from: string, to: string) => `${from} to ${to}`,
  clipDetail: (duration: string, track: string, type: string) => `${duration} on ${track}, ${type}`,
  clipsCount: (count: number) => `${count} clips`,
  moveTitle: (what: string) => `Move ${what}`,
  trimStart: (ripple: boolean, name: string) => `${ripple ? "Ripple trim" : "Trim"} start of ${name}`,
  trimEnd: (ripple: boolean, name: string) => `${ripple ? "Ripple trim" : "Trim"} end of ${name}`,
  sourceIn: (sign: string, amount: string) => `Source in ${sign}${amount}`,
  onTrack: (track: string) => ` on ${track}`,
  overlapRefused: "Overlaps a clip: will be refused",
  snappedPlayhead: "Snapped to the playhead",
  snappedEdge: "Snapped to a clip edge",
  clipListLabel: "Timeline clips",
  selected: "selected",
  /** Label of the scene band's head, under the zoom buttons. */
  scenes: "Scenes",
  scenesTitle: "Script scenes placed on their words. Click one to select its time range; dashed ones have no clip yet.",
  /** Screen-reader line of a scene span; `clips` is how many are linked to it, none meaning it is still empty. */
  sceneItem: (title: string, from: string, to: string, clips: number, selected: boolean) =>
    `Scene ${title}, ${from} to ${to}, ${clips === 0 ? "no clips yet" : `${clips} ${clips === 1 ? "clip" : "clips"}`}${selected ? ", selected" : ""}`,
  /** Canvas label of a clip whose end cannot be derived. */
  lengthUnknownShort: "length unknown",
  lengthUnknown: "Length unknown",
  muted: "muted",
  opacity: (percent: number) => `${percent}% opacity`,
  /** Shot layouts (ADR 0016), by stored value. */
  layouts: { solo: "Solo", "two-up": "Two-up", grid: "Grid", screen: "Screen", pip: "Screen + inset" },
  /** Label badge of a director's shot below the review threshold. */
  doubtful: (percent: number) => `${percent}% sure`,
  followedTrack: "the followed track",
  wordsShowHere: (track: string) => `Words show here once the clips of ${track} are transcribed`,
  showTurnLanes: "Show who speaks, one lane per angle",
  hideTurnLanes: "Hide the turn lanes",
  turnLanesTitle: (id: string, mac: boolean) =>
    `${id}: who speaks, one lane per angle. Drag on a lane to say that person speaks there and the others do not; ` +
    `Shift keeps the others, ${mac ? "Option" : "Alt"} marks that person silent; right-click goes back to the measured turns.`,
  turnLaneLabel: (name: string) => `Turns of ${name}`,
  turnLaneTitle: (name: string) => `${name}: speaking turns. Framed: said by hand. Hatched: marked silent by hand.`,
  turnsFailed: (reason: string) => `Turn lanes unavailable: ${reason}`,
  noShotToPaint: "No shot plays there: nothing to paint",
  backToMeasured: "Back to measured here",
  clearAnglePainted: (name: string) => `Clear everything painted for ${name}`,
  clearAllPainted: "Clear every painted turn",
  addDissolve: "Add dissolve",
  splitAtPlayhead: "Split at playhead",
  trimStartToPlayhead: "Trim start to playhead",
  trimEndToPlayhead: "Trim end to playhead",
  deleteClips: (count: number) => (count === 1 ? "Delete clip" : `Delete ${count} clips`),
  rippleDeleteClips: (count: number) => (count === 1 ? "Ripple delete clip" : `Ripple delete ${count} clips`),
  addFade: "Add fade",
  removeTransition: "Remove transition",
};

const es: typeof en = {
  showTimeline: "Mostrar la línea de tiempo",
  hideTimeline: "Ocultar la línea de tiempo",
  showTranscript: "Mostrar la transcripción",
  transcriptTitle: (shortcut) => `Abrir la vista de transcripción (${shortcut})`,
  rejected: (timeline, reason, preserved, message) =>
    `Se rechazó la edición de timelines/${timeline}.json (${reason}); se restauró la línea de tiempo. ` +
    `Tu versión se conserva en ${preserved}.\n${message}`,
  dismiss: "Descartar",
  emptyHint: "Pídele al agente en la terminal que corte tu material, o suelta archivos multimedia en {assets}.",
  keysLabel: (mac) => {
    const mod = mac ? "Comando" : "Control";
    return (
      `Pistas de la línea de tiempo. Clic selecciona un clip, Mayús o ${mod}+clic agrega o quita uno, ${mod}+A selecciona todo; ` +
      "arrastrar mueve los clips seleccionados, arrastra un borde para recortar (con Mayús al presionarlo, o R, recorta y cierra el hueco: los clips siguientes lo acompañan); " +
      "arrastrar sobre un espacio vacío selecciona un rango de tiempo; la regla mueve el cursor de reproducción. " +
      "Haz clic en un bloque de subtítulo para seleccionar sus palabras, o en una pista de subtítulos para definir su estilo. " +
      "S divide en el cursor de reproducción, [ y ] recortan hasta él, coma y punto mueven un fotograma, Suprimir elimina, Mayús+Suprimir elimina y cierra el hueco, " +
      "las flechas mueven el cursor de reproducción, N activa o desactiva el ajuste, Escape borra la selección. Más y menos hacen zoom, 0 ajusta la línea de tiempo. " +
      `${mod}+Z deshace, ${mac ? "Comando+Mayús+Z" : "Control+Y"} rehace, también desde el menú Edición.`
    );
  },
  nothingToUndo: "Nada que deshacer",
  nothingToRedo: "Nada que rehacer",
  addTrackFirst: "Primero agrega una pista de video o audio: los subtítulos siguen a una",
  notMoved: (count) => `No se movió: ${count} clips se superpondrían con un clip que se queda`,
  roughSnap: (window, time) => `No hay una pausa a menos de ${window} s de ${time}: el habla podría cortarse ahí`,
  edgeSnapped: (duration) => `El borde se ajustó ${duration} a una pausa`,
  saved: (label) => `${label} guardado`,
  savedMany: (label, count) => `${label} de ${count} clips guardado como un solo paso`,
  ops: {
    move: "Mover",
    trim: "Recortar",
    split: "Dividir",
    remove: "Eliminar",
    cut: "Eliminar y cerrar hueco",
    revert: "Deshacer",
    trackAdd: "Nueva pista",
    trackSet: "Cambio de pista",
    paint: "Turnos pintados",
  },
  noSelectedUnderPlayhead: "Ningún clip seleccionado bajo el cursor de reproducción",
  noClipUnderPlayhead: "Ningún clip bajo el cursor de reproducción",
  nothingToChange: "Nada que cambiar",
  selectClipFirst: "Primero selecciona un clip",
  zoomGroup: "Zoom y ajuste de la línea de tiempo",
  zoomOut: "Alejar",
  zoomOutTitle: "Alejar (-)",
  zoomFit: "Ajustar al panel",
  zoomFitTitle: "Ajustar al panel (0)",
  zoomIn: "Acercar",
  zoomInTitle: "Acercar (+)",
  snapping: "Ajuste magnético",
  snappingTitle: (mac) => `Ajustar a los bordes de los clips y al cursor de reproducción (N; mantén ${mac ? "Opción" : "Alt"} para invertir)`,
  rippleTrim: "Recortar y cerrar hueco",
  rippleTrimTitle:
    "Recortar y cerrar hueco: al arrastrar un borde, los clips siguientes lo acompañan sin dejar hueco (R; mantén Mayús al presionar un borde para invertir)",
  addSubtitleTrack: "Agregar pista de subtítulos",
  addSubtitleTitle: "Agregar subtítulos: las palabras de la transcripción de la pista del clip seleccionado (o de la primera transcrita)",
  subtitleHeadTitle: (id) => `${id}: selecciona para definir su estilo`,
  programHeadTitle: (id) => `${id}: selecciona para editar sus ángulos`,
  wordsOf: (label) => `Palabras de ${label}`,
  changesOf: (target) => `Cambios de ${target}`,
  diffKinds: { added: "agregados", removed: "eliminados", moved: "movidos", changed: "cambiados" },
  stopShowing: "Dejar de mostrar estos cambios",
  stopShowingTitle: "Dejar de mostrar estos cambios (Esc en las pistas)",
  range: (from, to) => `${from} a ${to}`,
  clipDetail: (duration, track, type) => `${duration} en ${track}, ${type}`,
  clipsCount: (count) => `${count} clips`,
  moveTitle: (what) => `Mover ${what}`,
  trimStart: (ripple, name) => `${ripple ? "Recortar y cerrar hueco" : "Recortar"} el inicio de ${name}`,
  trimEnd: (ripple, name) => `${ripple ? "Recortar y cerrar hueco" : "Recortar"} el final de ${name}`,
  sourceIn: (sign, amount) => `Entrada del original ${sign}${amount}`,
  onTrack: (track) => ` en ${track}`,
  overlapRefused: "Se superpone con un clip: se rechazará",
  snappedPlayhead: "Ajustado al cursor de reproducción",
  snappedEdge: "Ajustado al borde de un clip",
  clipListLabel: "Clips de la línea de tiempo",
  selected: "seleccionado",
  scenes: "Escenas",
  scenesTitle: "Escenas del guion colocadas sobre sus palabras. Haz clic en una para seleccionar su rango de tiempo; las de línea discontinua aún no tienen clip.",
  sceneItem: (title, from, to, clips, selected) =>
    `Escena ${title}, de ${from} a ${to}, ${clips === 0 ? "sin clips todavía" : `${clips} ${clips === 1 ? "clip" : "clips"}`}${selected ? ", seleccionada" : ""}`,
  lengthUnknownShort: "duración desconocida",
  lengthUnknown: "Duración desconocida",
  muted: "silenciado",
  opacity: (percent) => `${percent}% de opacidad`,
  layouts: { solo: "Individual", "two-up": "A dos", grid: "Cuadrícula", screen: "Pantalla", pip: "Pantalla + recuadro" },
  doubtful: (percent) => `${percent}% de certeza`,
  followedTrack: "la pista seguida",
  wordsShowHere: (track) => `Aquí aparecerán las palabras cuando se transcriban los clips de ${track}`,
  showTurnLanes: "Mostrar quién habla, una pista por ángulo",
  hideTurnLanes: "Ocultar las pistas de turnos",
  turnLanesTitle: (id, mac) =>
    `${id}: quién habla, una pista por ángulo. Arrastra sobre una pista para indicar que esa persona habla ahí y las demás no; ` +
    `Mayús conserva a las demás, ${mac ? "Opción" : "Alt"} la marca en silencio; clic derecho vuelve a los turnos medidos.`,
  turnLaneLabel: (name) => `Turnos de ${name}`,
  turnLaneTitle: (name) => `${name}: turnos de habla. Con marco: indicados a mano. Rayados: marcados en silencio a mano.`,
  turnsFailed: (reason) => `Pistas de turnos no disponibles: ${reason}`,
  noShotToPaint: "No hay ningún plano ahí: no hay nada que pintar",
  backToMeasured: "Volver a lo medido aquí",
  clearAnglePainted: (name) => `Borrar todo lo pintado para ${name}`,
  clearAllPainted: "Borrar todos los turnos pintados",
  addDissolve: "Añadir disolvencia",
  splitAtPlayhead: "Dividir en el cursor de reproducción",
  trimStartToPlayhead: "Recortar el inicio hasta el cursor",
  trimEndToPlayhead: "Recortar el final hasta el cursor",
  deleteClips: (count) => (count === 1 ? "Eliminar clip" : `Eliminar ${count} clips`),
  rippleDeleteClips: (count) => (count === 1 ? "Eliminar clip y cerrar hueco" : `Eliminar ${count} clips y cerrar hueco`),
  addFade: "Añadir fundido",
  removeTransition: "Quitar transición",
};

export const timeline = { en, es };
