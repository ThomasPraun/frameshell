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
  /** The brief of a video made from an idea (#472), offered above the terminals until used or hidden. */
  idea: {
    chip: "Make my film",
    ready: "Your project is ready, with its formats. Start an agent, then use the suggested prompt for your film.",
    /** Typed into the agent's prompt, unsent. `length` and `url` are empty when not given. Names no command: the agent finds the tools in the project's skill. */
    prompt: (name: string, formats: string, length: string, url: string) =>
      `I want a motion film made from scratch, with no footage. It is called "${name}". Formats: ${formats}.` +
      (length ? ` Length: ${length.toLowerCase()}.` : "") +
      (url ? ` Start from this page: ${url}.` : "") +
      " This Frameshell project is empty and its formats are already set; use the project's Frameshell skill and tools." +
      " First write three storylines, each in a different world, with a different device and form, and recommend one." +
      " Wait for my choice before building anything. Then list your assumptions, and put a free alternative next to every paid item (tools, stock, music, voices, fonts).",
  },
  connectClaude: "Connect Claude Desktop",
  disconnectClaude: "Disconnect Claude Desktop",
  claudeConnected: "Claude Desktop is connected",
  connectCode: "Connect Claude Code",
  disconnectCode: "Disconnect Claude Code",
  codeConnected: "Claude Code is connected",
  installCli: "Install the 'frameshell' command for other terminals",
  codeDialog: {
    connect: "Connect Claude Code to Frameshell?",
    connectDetail: (mcpFile: string, server: string, settingsFile: string, hook: string) =>
      `Frameshell adds this server to ${mcpFile}:\n\n${server}\n\nand this hook, which runs on every message you send in Claude Code, to ${settingsFile}:\n\n${hook}\n\nThe hook hands Claude Code what you send with "Chat about this"; it prints nothing outside a Frameshell project or with the app closed. Everything else in both files stays as it is, and each file is backed up first.`,
    connectButton: "Connect",
    cancel: "Cancel",
    connected: "Claude Code is connected. Restart your running Claude Code sessions to use Frameshell.",
    backups: (files: string) => `Backup of the previous settings:\n${files}`,
    disconnected: "Frameshell was removed from Claude Code. Restart your running Claude Code sessions to apply it.",
    notInstalled: "Claude Code is not installed on this computer.",
    failed: "Could not change Claude Code's settings.",
    invalid: (file: string) => `${file} is not valid JSON, or its hooks are not a list. Fix or remove it, then connect again.`,
  },
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
  idea: {
    chip: "Hacer mi película",
    ready: "Tu proyecto está listo, con sus formatos. Abre un agente y usa el prompt sugerido para tu película.",
    prompt: (name, formats, length, url) =>
      `Quiero una película de motion graphics hecha desde cero, sin grabaciones. Se llama "${name}". Formatos: ${formats}.` +
      (length ? ` Duración: ${length.toLowerCase()}.` : "") +
      (url ? ` Parte de esta página: ${url}.` : "") +
      " Este proyecto de Frameshell está vacío y sus formatos ya están definidos; usa la skill y las herramientas de Frameshell del proyecto." +
      " Primero escribe tres historias, cada una en un mundo distinto, con otro dispositivo y otra forma, y recomienda una." +
      " Espera mi elección antes de construir nada. Después enumera tus supuestos y pon una alternativa gratuita junto a cada elemento de pago (herramientas, stock, música, voces, tipografías).",
  },
  connectClaude: "Conectar Claude Desktop",
  disconnectClaude: "Desconectar Claude Desktop",
  claudeConnected: "Claude Desktop está conectado",
  connectCode: "Conectar Claude Code",
  disconnectCode: "Desconectar Claude Code",
  codeConnected: "Claude Code está conectado",
  installCli: "Instalar el comando 'frameshell' para otras terminales",
  codeDialog: {
    connect: "¿Conectar Claude Code con Frameshell?",
    connectDetail: (mcpFile, server, settingsFile, hook) =>
      `Frameshell agrega este servidor a ${mcpFile}:\n\n${server}\n\ny este hook, que se ejecuta con cada mensaje que envías en Claude Code, a ${settingsFile}:\n\n${hook}\n\nEl hook le entrega a Claude Code lo que envías con "Hablar de esto"; no imprime nada fuera de un proyecto de Frameshell ni con la app cerrada. Todo lo demás de ambos archivos queda como está y antes se guarda una copia de cada uno.`,
    connectButton: "Conectar",
    cancel: "Cancelar",
    connected: "Claude Code está conectado. Reinicia tus sesiones de Claude Code abiertas para usar Frameshell.",
    backups: (files) => `Copia de la configuración anterior:\n${files}`,
    disconnected: "Se quitó Frameshell de Claude Code. Reinicia tus sesiones de Claude Code abiertas para aplicarlo.",
    notInstalled: "Claude Code no está instalado en esta computadora.",
    failed: "No se pudo cambiar la configuración de Claude Code.",
    invalid: (file) => `${file} no es un JSON válido, o sus hooks no son una lista. Corrígelo o bórralo y vuelve a conectar.`,
  },
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
