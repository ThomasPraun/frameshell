// Test fixture: transcription provider with canned words, so MCP tests need no whisper.cpp.
export function activate(api) {
  api.registerTranscriptionProvider({
    id: "fake",
    async transcribe(_audio, options, context) {
      context.progress({ message: "Transcribing (fake)", fraction: 1 });
      return {
        model: "canned",
        language: options.language ?? "es",
        words: [
          { text: "Hola", start: 0.2, end: 0.5, confidence: 0.9 },
          { text: "mundo.", start: 1.2, end: 1.6, confidence: 0.8 },
        ],
      };
    },
  });
}
