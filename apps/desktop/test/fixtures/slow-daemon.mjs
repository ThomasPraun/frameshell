// Stand-in daemon entry for DaemonLink tests: waits FAKE_DAEMON_DELAY_MS before running the real frameshelld,
// like a cold daemon on a loaded machine that is slow to start listening.
await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_DAEMON_DELAY_MS ?? "0")));
await import(import.meta.resolve("@frameshell/core/frameshelld"));
