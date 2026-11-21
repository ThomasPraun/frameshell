// Agent guide above the terminals (renderer/src/components/AgentGuide.tsx) and "Connect your AI"
// (renderer/src/components/ConnectAi.tsx).

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
  /** Page of the website in this language. */
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
  /** Suggestions in a project made from an idea, with no footage to cut (#752). */
  ideaPrompts: [
    "Show me the storylines again",
    "Add music that fits the film",
    "Add a voiceover",
    "Check that the vertical version reads well",
    "Export a draft",
  ],
  suggestionTitle: "Types it into the agent's prompt; press Enter to send",
  /** The brief of a video made from an idea, offered above the terminals until used or hidden. */
  idea: {
    chip: "Make my film",
    ready: "Your project is ready, with its formats. Copy the prompt into your AI app, or start an agent here and use it.",
    /** The prompt shown in the guide, with or without an agent running (#752). */
    promptLabel: "Prompt for your film",
    copy: "Copy prompt",
    copied: "Copied",
    /** The prompt was used or put away: one line brings it back; the brief stays in brief.md. */
    showAgain: "Show the prompt for your film",
    putAway: "Done with it",
    /** Typed into the agent's prompt, unsent. `length`, `url` and `about` are empty when not given. Names no command: the agent finds the tools in the project's skill. */
    prompt: (name: string, formats: string, length: string, url: string, about: string) =>
      `I want a motion film made from scratch, with no footage. It is called "${name}". Formats: ${formats}.` +
      (about ? ` What it is about: ${about}` + (/[.!?]$/.test(about) ? "" : ".") : "") +
      (length ? ` Length: ${length.toLowerCase()}.` : "") +
      (url ? ` Start from this page: ${url}.` : "") +
      " The brief is in brief.md." +
      " This Frameshell project is empty and its formats are already set; use the project's Frameshell skill and tools." +
      " First write three storylines, each in a different world, with a different device and form, and recommend one." +
      " Wait for my choice before building anything. Then list your assumptions, and put a free alternative next to every paid item (tools, stock, music, voices, fonts).",
  },
  /** Opens "Connect your AI" from the guide, before the terminal agents. */
  desktopApps: "Prefer an app? Connect Claude Desktop or ChatGPT",
  installCli: "Install the 'frameshell' command for other terminals",
  /** "Connect your AI" (renderer/src/components/ConnectAi.tsx): desktop apps first, developer tools after. */
  connect: {
    open: "Connect your AI",
    openTitle: "Use Claude Desktop, ChatGPT or another AI app to edit with Frameshell",
    title: "Connect your AI",
    lede: "Connect an AI app you already use, then ask it in your own words to edit the video open here. Frameshell adds itself to the app's settings; everything else there stays as it is, and a copy is kept first.",
    close: "Close",
    checkAgain: "Check again",
    /** Reveals an AI app's settings file that does not parse (#753). */
    showFile: "Show the file",
    fixFileFirst: "Fix or remove the settings file first",
    connect: "Connect",
    connectAgain: "Connect again",
    disconnect: "Disconnect",
    connected: "Connected",
    working: "Working…",
    notAvailable: "Not available on this system.",
    notInstalled: (name: string) => `${name} is not on this computer yet. Install it, open it once, then Check again.`,
    different: "Frameshell is set up there with another command. Connect again to use this app.",
    restartConnected: (name: string) => `Done. Quit and reopen ${name} to finish.`,
    restartDisconnected: (name: string) => `Frameshell was removed. Quit and reopen ${name} to finish.`,
    backups: (files: string) => `Copy of the previous settings: ${files}`,
    invalid: (file: string) => `${file} is not valid, so Frameshell left it alone. Fix or remove it, then connect again.`,
    failed: (message: string) => `Could not change the settings: ${message}`,
    desktop: "Desktop apps",
    developers: "For developers",
    developersLede: "Command-line tools and code editors.",
    openApp: (app: string) => `Open ${app}`,
    downloadApp: (app: string) => `Download ${app}`,
    copiedPaste: (app: string) => `Copied: paste it in ${app}.`,
    notFound: (name: string) => `${name} was not found on this computer. Download it, install it, then try Open again.`,
    openFailed: (message: string) => `Could not open the app: ${message}`,
    /** Put on the clipboard when an app opens, to paste as the first message. */
    starter: {
      project: (name: string) => `Work on my open Frameshell project: ${name}.`,
      general: "Use Frameshell to help me edit a video.",
    },
    apps: {
      claudeDesktop: { name: "Claude Desktop", short: "Claude", label: "Claude Desktop", about: "Anthropic's Claude app for Mac and Windows." },
      chatgpt: {
        name: "ChatGPT (desktop app)",
        short: "ChatGPT",
        label: "ChatGPT",
        about: "OpenAI's ChatGPT app for your computer.",
        note: "Uses the MCP servers setting the app shares with Codex; you may need its Codex mode. ChatGPT on the web is not supported.",
      },
      claudeCode: { name: "Claude Code", about: "Adds the server and a prompt hook that hands Claude Code what you send with Chat about this." },
      codexCli: { name: "Codex CLI", about: "Same settings file as the ChatGPT desktop app: connecting one connects both." },
      gemini: { name: "Gemini CLI", about: "Google's Gemini in the terminal." },
    },
    others: {
      name: "Cursor, VS Code and others",
      about: "Paste this into the app's MCP settings.",
      mcpServers: "Cursor and most apps",
      vscode: "VS Code (mcp.json)",
      copy: "Copy",
      copied: "Copied",
    },
    /** The card on the welcome screen. */
    welcome: {
      title: "Edit by asking your AI",
      body: "Connect Claude Desktop or ChatGPT and tell it what to change. No terminal needed.",
    },
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
  ideaPrompts: [
    "Muéstrame de nuevo las historias",
    "Agrega música que vaya con la película",
    "Agrega una voz en off",
    "Revisa que la versión vertical se lea bien",
    "Exporta un borrador",
  ],
  suggestionTitle: "Lo escribe en el prompt del agente; presiona Enter para enviarlo",
  idea: {
    chip: "Hacer mi película",
    ready: "Tu proyecto está listo, con sus formatos. Copia el prompt en tu app de IA, o abre un agente aquí y úsalo.",
    promptLabel: "Prompt para tu película",
    copy: "Copiar prompt",
    copied: "Copiado",
    showAgain: "Mostrar el prompt de tu película",
    putAway: "Ya lo usé",
    prompt: (name, formats, length, url, about) =>
      `Quiero una película de motion graphics hecha desde cero, sin grabaciones. Se llama "${name}". Formatos: ${formats}.` +
      (about ? ` De qué trata: ${about}` + (/[.!?]$/.test(about) ? "" : ".") : "") +
      (length ? ` Duración: ${length.toLowerCase()}.` : "") +
      (url ? ` Parte de esta página: ${url}.` : "") +
      " El brief está en brief.md." +
      " Este proyecto de Frameshell está vacío y sus formatos ya están definidos; usa la skill y las herramientas de Frameshell del proyecto." +
      " Primero escribe tres historias, cada una en un mundo distinto, con otro dispositivo y otra forma, y recomienda una." +
      " Espera mi elección antes de construir nada. Después enumera tus supuestos y pon una alternativa gratuita junto a cada elemento de pago (herramientas, stock, música, voces, tipografías).",
  },
  desktopApps: "¿Prefieres una app? Conecta Claude Desktop o ChatGPT",
  installCli: "Instalar el comando 'frameshell' para otras terminales",
  connect: {
    open: "Conecta tu IA",
    openTitle: "Usa Claude Desktop, ChatGPT u otra app de IA para editar con Frameshell",
    title: "Conecta tu IA",
    lede: "Conecta una app de IA que ya usas y pídele con tus palabras que edite el video abierto aquí. Frameshell se agrega a la configuración de la app; todo lo demás queda como está y antes se guarda una copia.",
    close: "Cerrar",
    checkAgain: "Volver a buscar",
    showFile: "Mostrar el archivo",
    fixFileFirst: "Primero corrige o borra el archivo de configuración",
    connect: "Conectar",
    connectAgain: "Volver a conectar",
    disconnect: "Desconectar",
    connected: "Conectado",
    working: "Trabajando…",
    notAvailable: "No está disponible en este sistema.",
    notInstalled: (name) => `${name} todavía no está en esta computadora. Instálalo, ábrelo una vez y luego toca Volver a buscar.`,
    different: "Frameshell está configurado ahí con otro comando. Vuelve a conectar para usar esta app.",
    restartConnected: (name) => `Listo. Cierra ${name} y vuelve a abrirlo para terminar.`,
    restartDisconnected: (name) => `Se quitó Frameshell. Cierra ${name} y vuelve a abrirlo para terminar.`,
    backups: (files) => `Copia de la configuración anterior: ${files}`,
    invalid: (file) => `${file} no es válido, así que Frameshell no lo tocó. Corrígelo o bórralo y vuelve a conectar.`,
    failed: (message) => `No se pudo cambiar la configuración: ${message}`,
    desktop: "Apps de escritorio",
    developers: "Para desarrolladores",
    developersLede: "Herramientas de línea de comandos y editores de código.",
    openApp: (app) => `Abrir ${app}`,
    downloadApp: (app) => `Descargar ${app}`,
    copiedPaste: (app) => `Copiado: pégalo en ${app}.`,
    notFound: (name) => `No se encontró ${name} en esta computadora. Descárgalo, instálalo y vuelve a tocar Abrir.`,
    openFailed: (message) => `No se pudo abrir la app: ${message}`,
    starter: {
      project: (name) => `Trabaja en mi proyecto de Frameshell abierto: ${name}.`,
      general: "Usa Frameshell para ayudarme a editar un video.",
    },
    apps: {
      claudeDesktop: { name: "Claude Desktop", short: "Claude", label: "Claude Desktop", about: "La app de Claude de Anthropic para Mac y Windows." },
      chatgpt: {
        name: "ChatGPT (app de escritorio)",
        short: "ChatGPT",
        label: "ChatGPT",
        about: "La app de ChatGPT de OpenAI para tu computadora.",
        note: "Usa la opción de servidores MCP que la app comparte con Codex; puede que necesites su modo Codex. ChatGPT en la web no es compatible.",
      },
      claudeCode: { name: "Claude Code", about: "Agrega el servidor y un hook que le entrega a Claude Code lo que envías con Hablar de esto." },
      codexCli: { name: "Codex CLI", about: "Usa el mismo archivo de configuración que la app de escritorio de ChatGPT: conectar uno conecta ambos." },
      gemini: { name: "Gemini CLI", about: "Gemini de Google en la terminal." },
    },
    others: {
      name: "Cursor, VS Code y otras",
      about: "Pega esto en la configuración MCP de la app.",
      mcpServers: "Cursor y la mayoría de las apps",
      vscode: "VS Code (mcp.json)",
      copy: "Copiar",
      copied: "Copiado",
    },
    welcome: {
      title: "Edita pidiéndoselo a tu IA",
      body: "Conecta Claude Desktop o ChatGPT y dile qué cambiar. No necesitas la terminal.",
    },
  },
};

/** English and Spanish strings of the agent guide and "Connect your AI". */
export const agents = { en, es };
