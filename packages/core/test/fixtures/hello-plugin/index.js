// Test fixture: smallest plugin exercising a command and an export preset.
export function activate(api) {
  api.registerCommand("hello greet", {
    description: "Greet someone from inside the daemon",
    run({ args, project }) {
      if (args[0] === "--fail") throw new Error("greeting refused");
      const name = args[0] ?? "world";
      return { output: `Hello, ${name}!`, data: { greeted: name, project: project.dir } };
    },
  });
  api.registerExportPreset({
    id: "hello-square",
    label: "Hello square 1080",
    container: "mp4",
    video: { codec: "h264", width: 1080, height: 1080, crf: 20 },
    audio: { codec: "aac", bitrateKbps: 192 },
    loudness: -14,
  });
}
