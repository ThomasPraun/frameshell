/** What an official plugin adds; the wire schema of `plugin.catalog` takes its enum from this list. */
export const OFFICIAL_PLUGIN_KINDS = ["clip-adapter", "transcription-provider", "speech-provider"] as const;

/** What an official plugin adds. */
export type OfficialPluginKind = (typeof OFFICIAL_PLUGIN_KINDS)[number];

/** What a person must have or do before an official plugin is useful; the wire schema takes its enum from this list. */
export const PLUGIN_NEED_KINDS = ["none", "blender", "openai-key", "remotion-project"] as const;

/** What a person must have or do before an official plugin is useful. */
export type PluginNeedKind = (typeof PLUGIN_NEED_KINDS)[number];

/** A managed download an official plugin asks for on first use. Sizes come from the binary manifest, never from here. */
export interface OfficialDownload {
  /** `binary`: a package of `packages/core/src/binaries/manifest.ts`; `model`: a `ManagedModel` id of the same file. */
  kind: "binary" | "model";
  /** Package name (`chrome-headless-shell`) or model id (`ggml-large-v3-turbo-q5_0`). */
  id: string;
  /** What the download is, for a person. */
  what: string;
  /**
   * Set on the default model of a transcription provider: a project or machine that picks another model of
   * `provider` downloads managed model `prefix` + that model instead, and `plugin.catalog` reports that one.
   */
  chosenModel?: { provider: string; prefix: string };
}

/** One official plugin: what it is for, what it needs and what it downloads. */
export interface OfficialPlugin {
  /** npm package name, also its key in a project's `frameshell.json`. */
  name: string;
  /** What the plugin adds. */
  kind: OfficialPluginKind;
  /** Clip type (`clip-adapter`) or provider id (the others) it contributes. */
  provides: readonly string[];
  /** One sentence for a person: what it lets them do. */
  purpose: string;
  /** What the person must have or do: `text` in words, `variable` the environment variable of a key need (`openai-key`). */
  need: { kind: PluginNeedKind; text: string; variable?: string };
  /** The provider charges per use. */
  paid: boolean;
  /** Audio or text leaves the machine. */
  cloud: boolean;
  /** Downloaded when a feature first runs, not when the plugin is installed. */
  downloads: readonly OfficialDownload[];
}

/** Equals `KEY_VARIABLE` of both OpenAI plugins; `official-plugins.test.ts` checks it. */
const OPENAI_VARIABLE = "OPENAI_API_KEY";
const OPENAI_KEY = `Your own OpenAI API key in the ${OPENAI_VARIABLE} environment variable, paid per use to OpenAI`;

/**
 * The one list of official plugins. The daemon's install hints, the `plugin.catalog` method (CLI, MCP and app) and
 * the app's setup of transcription read it. Parity with `plugins/` (names, contributions, download ids) is
 * tested in `packages/core/test/official-plugins.test.ts`.
 */
export const OFFICIAL_PLUGINS: readonly OfficialPlugin[] = [
  {
    name: "@frameshell/whisper-cpp",
    kind: "transcription-provider",
    provides: ["whisper-cpp"],
    purpose: "Transcribes the speech in your footage into words with times, on this computer.",
    need: { kind: "none", text: "Nothing: it runs on this computer and uploads nothing." },
    paid: false,
    cloud: false,
    downloads: [
      { kind: "binary", id: "whisper-cpp", what: "whisper.cpp speech recognizer (a GPU build when this machine has one)" },
      { kind: "model", id: "ggml-large-v3-turbo-q5_0", what: "Speech model large-v3-turbo, 5-bit", chosenModel: { provider: "whisper-cpp", prefix: "ggml-" } },
    ],
  },
  {
    name: "@frameshell/openai-transcription",
    kind: "transcription-provider",
    provides: ["openai"],
    purpose: "Transcribes speech with OpenAI's cloud service instead of on this computer.",
    need: { kind: "openai-key", variable: OPENAI_VARIABLE, text: `${OPENAI_KEY}; the audio is uploaded, and Frameshell asks before every upload.` },
    paid: true,
    cloud: true,
    downloads: [],
  },
  {
    name: "@frameshell/openai-speech",
    kind: "speech-provider",
    provides: ["openai"],
    purpose: "Generates voiceover narration from text with OpenAI's cloud voices.",
    need: { kind: "openai-key", variable: OPENAI_VARIABLE, text: `${OPENAI_KEY}; the voiceover text is sent to OpenAI, and Frameshell shows the cost and asks first.` },
    paid: true,
    cloud: true,
    downloads: [],
  },
  {
    name: "@frameshell/hyperframes",
    kind: "clip-adapter",
    provides: ["hyperframes"],
    purpose: "Adds animated titles, overlays and graphics written as HTML, rendered to clips with transparency.",
    need: { kind: "none", text: "Nothing: it renders in a headless Chrome that Frameshell downloads." },
    paid: false,
    cloud: false,
    downloads: [
      { kind: "binary", id: "chrome-headless-shell", what: "Headless Chrome that renders the HTML" },
      { kind: "binary", id: "ffmpeg", what: "ffmpeg and ffprobe, which encode the render (also used by every video import)" },
    ],
  },
  {
    name: "@frameshell/remotion",
    kind: "clip-adapter",
    provides: ["remotion"],
    purpose: "Adds animated scenes and overlays built with React (Remotion), rendered to clips with transparency.",
    need: {
      kind: "remotion-project",
      text:
        "A Remotion project with its npm packages installed (`frameshell remotion new` makes one). " +
        "Remotion's own licence applies: companies above a size threshold need a Remotion company licence.",
    },
    paid: false,
    cloud: false,
    downloads: [{ kind: "binary", id: "chrome-headless-shell", what: "Headless Chrome that renders the scenes" }],
  },
  {
    name: "@frameshell/blender",
    kind: "clip-adapter",
    provides: ["blender"],
    purpose: "Adds 3D scenes from .blend files, rendered to clips with transparency.",
    need: { kind: "blender", text: "Your own Blender installed on this computer (4.5 LTS and 5.x); Frameshell never downloads it." },
    paid: false,
    cloud: false,
    downloads: [{ kind: "binary", id: "ffmpeg", what: "ffmpeg and ffprobe, which encode the render (also used by every video import)" }],
  },
];

/** The official plugin named `name`, or undefined. */
export function officialPlugin(name: string): OfficialPlugin | undefined {
  return OFFICIAL_PLUGINS.find((plugin) => plugin.name === name);
}

/** The official plugin that contributes clip type or provider `id` of `kind`, or undefined. */
export function officialPluginProviding(kind: OfficialPluginKind, id: string): OfficialPlugin | undefined {
  return OFFICIAL_PLUGINS.find((plugin) => plugin.kind === kind && plugin.provides.includes(id));
}

/** Terminal command that installs official plugin `plugin`. */
export function installCommand(plugin: Pick<OfficialPlugin, "name">): string {
  return `frameshell plugin install ${plugin.name}`;
}

/** Sentence (leading space) saying how to get official plugin `plugin`. */
export function installHint(plugin: Pick<OfficialPlugin, "name">): string {
  return ` Install ${plugin.name} with \`${installCommand(plugin)}\`; \`frameshell plugin catalog\` lists what official plugins need and download.`;
}
