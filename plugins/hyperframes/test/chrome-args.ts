/**
 * Launch flags of the headless Chrome the real tests open themselves: Chrome refuses to start as root with its
 * sandbox on (a CI or cloud container), so there it runs without it, as the producer's own renders do.
 */
export const TEST_CHROME_ARGS: readonly string[] = process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [];
