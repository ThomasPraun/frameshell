// Agent guide above the terminals (#190, renderer/src/components/AgentGuide.tsx) and the Claude Desktop connection
// dialogs (#191, main/index.ts).

const en = {
  title: "Talk to an agent",
  lede: "An AI agent edits this project from the terminal. Start one and ask in your own words.",
  start: (name: string) => `Start ${name}`,
  found: "Installed",
  notFound: "Not installed yet. Install one:",
  installOther: "Install another agent",
  install: (name: string) => `Install ${name}`,
  /** After the install command is typed into the terminal, unsent. */
  installTyped: "The install command is in the terminal. Press Enter there to run it, then Check again.",
  checkAgain: "Check again",
  unattended: "Runs commands without asking first",
  howTo: "How to connect each agent",
  /** Page of the website in this language (#196). */
  howToUrl: "https://frameshell.dev/agents",
  hide: "Hide",
  show: "Agent help",
  suggestions: "Ask it to…",
  /** Typed into the agent's prompt, unsent: in the UI language, agents answer in kind. */
  prompts: [
    "Remove the silences and long pauses",
    "Add subtitles",
    "Cut the mistakes and repeated takes",
    "Make a vertical short from the best moment",
    "Add my logo in a corner",
  ],
  suggestionTitle: "Types it into the agent's prompt; press Enter to send",
  connectClaude: "Connect Claude Desktop",
  disconnectClaude: "Disconnect Claude Desktop",
  claudeConnected: "Claude Desktop is connected",
  installCli: "Install the 'frameshell' command for other terminals",
  dialog: {
    connect: "Connect Claude Desktop to Frameshell?",
    connectDetail: (file: string, entry: string) =>
      `Frameshell adds this server to ${file}:\n\n${entry}\n\nOther servers stay as they are, and the file is backed up first. Claude Desktop then works on the project open in Frameshell.`,
    connectButton: "Connect",
    cancel: "Cancel",
    connected: "Claude Desktop is connected. Quit and reopen Claude Desktop to use Frameshell.",
    backup: (file: string) => `Backup of the previous settings: ${file}`,
    disconnected: "Frameshell was removed from Claude Desktop. Quit and reopen Claude Desktop to apply it.",
    notInstalled: "Claude Desktop is not installed on this computer.",
    failed: "Could not change Claude Desktop's settings.",
    invalid: (file: string) => `${file} is not valid JSON. Fix or remove it, then connect again.`,
  },
};

const es: typeof en = {
  title: "Habla con un agente",
  lede: "Un agente de IA edita este proyecto desde la terminal. Abre uno y pídele lo que quieras con tus palabras.",
  start: (name) => `Abrir ${name}`,
  found: "Instalado",
  notFound: "Todavía no tienes ninguno. Instala uno:",
  installOther: "Instalar otro agente",
  install: (name) => `Instalar ${name}`,
  installTyped: "El comando de instalación está en la terminal. Presiona Enter allí para ejecutarlo y luego Volver a buscar.",
  checkAgain: "Volver a buscar",
  unattended: "Ejecuta comandos sin preguntar antes",
  howTo: "Cómo conectar cada agente",
  howToUrl: "https://frameshell.dev/es/agents",
  hide: "Ocultar",
  show: "Ayuda del agente",
  suggestions: "Pídele que…",
  prompts: [
    "Quita los silencios y las pausas largas",
    "Agrega subtítulos",
    "Corta los errores y las tomas repetidas",
    "Haz un short vertical con el mejor momento",
    "Agrega mi logo en una esquina",
  ],
  suggestionTitle: "Lo escribe en el prompt del agente; presiona Enter para enviarlo",
  connectClaude: "Conectar Claude Desktop",
  disconnectClaude: "Desconectar Claude Desktop",
  claudeConnected: "Claude Desktop está conectado",
  installCli: "Instalar el comando 'frameshell' para otras terminales",
  dialog: {
    connect: "¿Conectar Claude Desktop con Frameshell?",
    connectDetail: (file, entry) =>
      `Frameshell agrega este servidor a ${file}:\n\n${entry}\n\nLos demás servidores quedan como están y antes se guarda una copia del archivo. Después, Claude Desktop trabaja en el proyecto abierto en Frameshell.`,
    connectButton: "Conectar",
    cancel: "Cancelar",
    connected: "Claude Desktop está conectado. Cierra Claude Desktop y vuelve a abrirlo para usar Frameshell.",
    backup: (file) => `Copia de la configuración anterior: ${file}`,
    disconnected: "Se quitó Frameshell de Claude Desktop. Cierra Claude Desktop y vuelve a abrirlo para aplicarlo.",
    notInstalled: "Claude Desktop no está instalado en esta computadora.",
    failed: "No se pudo cambiar la configuración de Claude Desktop.",
    invalid: (file) => `${file} no es un JSON válido. Corrígelo o bórralo y vuelve a conectar.`,
  },
};

export const agents = { en, es };
