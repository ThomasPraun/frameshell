// @ts-check
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://frameshell.dev",
  // The showcase markup relies on whitespace between inline elements (e.g. "TIMELINE TALKS").
  compressHTML: false,
  i18n: {
    locales: ["en", "es"],
    defaultLocale: "en",
    routing: { prefixDefaultLocale: false },
  },
});
