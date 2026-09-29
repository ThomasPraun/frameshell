import type { FrameshellApi } from "../../shared/api.js";

declare global {
  interface Window {
    /** Exposed by the preload; the renderer's only way to reach main. */
    readonly frameshell: FrameshellApi;
  }
}
