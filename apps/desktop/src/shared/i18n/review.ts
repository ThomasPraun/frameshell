// Review mode (ADR 0019): the switch, the proposal bar and its Before / After toggle
// (renderer/src/components/ProposalBar.tsx, ReviewSwitch.tsx).

const en = {
  switchLabel: "Review agent changes before applying",
  switchHint: "Changes made outside the app wait for you to accept or reject them. Your own edits apply at once.",
  barLabel: "Agent proposal",
  untitled: "Agent changes",
  building: (who: string) => `${who} is working…`,
  ready: (who: string) => `${who} proposes changes`,
  operations: (count: number) => `${count} ${count === 1 ? "operation" : "operations"}`,
  sideLabel: "Show timeline",
  before: "Before",
  after: "After",
  accept: "Accept",
  reject: "Reject",
  beforeHint: "Show the project as it is now, without this change",
  afterHint: "Show the project with this change applied",
  acceptHint: "Apply this change to the project",
  rejectHint: "Discard this change: the project stays as it is",
  stale: "Out of date: you changed the same clips",
  staleIds: (ids: string) => `Both changed: ${ids}`,
  staleAdvice: "The agent has to redo it.",
  dismiss: "Dismiss",
};

const es: typeof en = {
  switchLabel: "Revisar los cambios del agente antes de aplicarlos",
  switchHint: "Los cambios hechos fuera de la app esperan a que los aceptes o rechaces. Tus propias ediciones se aplican al instante.",
  barLabel: "Propuesta del agente",
  untitled: "Cambios del agente",
  building: (who) => `${who} está trabajando…`,
  ready: (who) => `${who} propone cambios`,
  operations: (count) => `${count} ${count === 1 ? "operación" : "operaciones"}`,
  sideLabel: "Mostrar la línea de tiempo",
  before: "Antes",
  after: "Después",
  accept: "Aceptar",
  reject: "Rechazar",
  beforeHint: "Mostrar el proyecto como está ahora, sin este cambio",
  afterHint: "Mostrar el proyecto con este cambio aplicado",
  acceptHint: "Aplicar este cambio al proyecto",
  rejectHint: "Descartar este cambio: el proyecto queda como está",
  stale: "Desactualizada: cambiaste los mismos clips",
  staleIds: (ids) => `Ambos cambiaron: ${ids}`,
  staleAdvice: "El agente tiene que rehacerla.",
  dismiss: "Descartar",
};

export const review = { en, es };
