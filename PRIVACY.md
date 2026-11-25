# Privacy policy

Frameshell is a desktop app. Your projects, media, transcripts, voice prints and settings stay on your computer. Frameshell has **no telemetry**: it collects no usage data, no crash reports and no identifiers, and it has no servers of its own.

It connects to other systems only in these cases:

| When | To | What is sent |
|---|---|---|
| A check for a new version, 10 seconds after start and then once a day. Turn it off with **Check for Updates Automatically** (macOS: app menu; Windows and Linux: Help). | GitHub (`api.github.com`, `github.com`) | A request for the latest release of this repository. GitHub sees your IP address, as with any download. |
| A feature you use needs a tool or model for the first time (ffmpeg, whisper.cpp, headless Chrome, transcription and other models). | The pinned download sources listed in [docs/binaries.md](docs/binaries.md) (GitHub, Hugging Face and others) | A download request. Each file is checked against a pinned SHA-256. |
| You install a plugin, from the Plugins view or `frameshell plugin install`. | The npm registry (`registry.npmjs.org`) | A download request for that package. |
| You choose a cloud provider, for example OpenAI voices or OpenAI transcription, and save its API key. Frameshell shows the cost and asks before each paid run. | That provider (for OpenAI: `api.openai.com`) | The text or audio you asked it to process, with your key. That provider's own privacy policy applies. |
| You connect an AI app (Claude Desktop, the ChatGPT desktop app, a coding agent). | Nothing, from Frameshell: the AI app talks to Frameshell on your computer. | What you share with your AI app is governed by that app's provider. |

**Help → Copy Diagnostics** puts a report on your clipboard; nothing is sent unless you paste it somewhere yourself.

Questions: open an [issue](https://github.com/ThomasPraun/frameshell/issues).
