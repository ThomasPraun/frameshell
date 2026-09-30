# Managed binaries

frameshelld downloads native tools on first use instead of bundling them (SPEC §9). This page records which builds are pinned, where they come from, their licences, and how to re-pin. The manifest itself is `packages/core/src/binaries/manifest.ts`.

## How it works

- Pins are per platform (`<os>-<arch>`): version, URLs (first one is canonical, later ones are mirrors), SHA-256, size, and the path of each executable inside the archive.
- A platform can pin several candidates in preference order (GPU first). An optional candidate names its `accelerator` and `requires` machine probes (commands that must exit 0, e.g. `nvidia-smi -L`). The manager takes the first candidate whose probes all pass. The last candidate has no probes: it is the CPU fallback. Probes run once per daemon. Optional candidates install beside the default one, in `<platform>-<accelerator>/`.
- If an optional candidate fails to build, or its built executable does not start, the manager writes `<platform>-<accelerator>.failed.json` (with the error) next to its install dir, reports it as progress, and installs the next candidate. That candidate is skipped until the file is deleted. A download or checksum failure never falls back.
- Install location: `<dataDir>/binaries/<package>/<version>/<platform>/`, with an `install.json` recording the source URL, checksum and licence. See [User directories](#user-directories) for `dataDir`.
- Install steps: download to a private staging directory while hashing, abort on checksum mismatch, extract only the pinned members with the system `tar`, then publish with one directory rename. A failed install leaves nothing behind. Concurrent requests share one download.
- Extraction uses the system `tar`: bsdtar on macOS and Windows (`%SystemRoot%\System32\tar.exe`) reads zip and tar; GNU tar on Linux needs `xz` for `.tar.xz`. So Linux pins must be tar archives.
- `support` members (shared libraries, licences) are placed next to the tools under the name the pin gives them, so shared libraries sit under their SONAME and no symlinks are needed.
- A pin with `build` compiles the tools on the user's machine instead: `cmake --version` is checked before anything is downloaded, then the pinned source archive is downloaded and verified like any archive, configured and built out of tree in the staging directory, and only the built executables are published. Compile jobs are one per core, capped at one per 2 GB of RAM (ggml's Vulkan shader sources get 8 parallel jobs OOM-killed in 4 GB). A built optional (GPU) executable must answer its version probe before it is published.
- Models (`<dataDir>/models/<id>/<revision>/<file>`) are single files pinned by URL, revision and SHA-256, downloaded on first use the same way.
- Long installs report progress (download percent, configure, build). `frameshell transcribe` prints it on stderr.
- On-demand packages (whisper.cpp) are listed by `doctor` but never reported missing and never installed by `doctor --install`: the first transcription installs them.
- `frameshell doctor` only reports. It downloads only with `--install`. Other features call `BinaryManager.ensure()`, which downloads on first use.

## User directories

One resolver, `resolveAppDirs()` in `packages/protocol/src/app-dirs.ts`, places every piece of per-user state for the daemon, the CLI and the desktop app. It splits it in two:

- `dataDir`: large or regenerable state that must not roam between machines. Managed binaries, downloads, caches, and the desktop app's Electron data (`<dataDir>/desktop`: Chromium profile, layouts, recent projects, CLI shim).
- `configDir`: small user decisions. The global `config.json` and project trust decisions (`trust.json`).

| OS | `dataDir` | `configDir` |
|---|---|---|
| macOS | `~/Library/Application Support/Frameshell` | same as `dataDir` |
| Linux | `$XDG_DATA_HOME/frameshell` (default `~/.local/share/frameshell`) | `$XDG_CONFIG_HOME/frameshell` (default `~/.config/frameshell`) |
| Windows | `%LOCALAPPDATA%\Frameshell` | `%APPDATA%\Frameshell` (roams) |

`FRAMESHELL_DATA_DIR` and `FRAMESHELL_CONFIG_DIR` override each one (tests, portable installs). They are the only overrides: `FRAMESHELL_APP_DATA` and `FRAMESHELL_USER_DATA_DIR` were removed.

Upgrading keeps existing state. Binaries were always in `dataDir`, and trust was already in `configDir` on macOS and Windows. On Linux, earlier builds kept `trust.json` in `dataDir`: the daemon reads it from there while `<configDir>/trust.json` is missing, and the next trust decision writes everything to `configDir`.

## Overrides

Set `binaries` in `frameshell.json` (project) or in `<configDir>/config.json` (global):

```json
{ "binaries": { "ffmpeg": "/opt/homebrew/bin/ffmpeg" } }
```

- The value is `"managed"` or a path. Relative paths resolve against the project root (project config) or the config directory (global config).
- Precedence: project, then global, then managed. `"managed"` in the project cancels a global override.
- Overriding one tool of a package also takes its siblings from the same directory (`ffprobe` next to `ffmpeg`), unless the sibling has its own entry.

## ffmpeg and ffprobe

Requirements: GPL build with libx264, and libvpx with both the VP9 encoder and decoder. The native `vp9` decoder drops alpha (ADR 0002). Static builds only, so nothing depends on system libraries.

| Platform | Version | Builder | Archive | Licence |
|---|---|---|---|---|
| darwin-arm64 | 9.0.2 | [Martin Riedl](https://ffmpeg.martin-riedl.de) | `ffmpeg.zip` + `ffprobe.zip` (28 MB each) | GPL-3.0-or-later (`--enable-gpl --enable-version3`, no `--enable-nonfree`) |
| darwin-x64 | 9.0.2 | Martin Riedl | `ffmpeg.zip` + `ffprobe.zip` (34 MB each) | GPL-3.0-or-later |
| linux-x64 | n9.0.1-11-ge47273f4d9 | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) `autobuild-2026-08-31-13-27` | `linux64-gpl-9.0.tar.xz` (127 MB) | GPL-3.0-or-later (`--enable-gpl --enable-version3`) |
| linux-arm64 | n9.0.1-11-ge47273f4d9 | BtbN | `linuxarm64-gpl-9.0.tar.xz` (109 MB) | GPL-3.0-or-later |
| win32-x64 | n9.0.1-11-ge47273f4d9 | BtbN | `win64-gpl-9.0.zip` (169 MB) | GPL-3.0-or-later |

Why these builders:

- **Martin Riedl (macOS).** He publishes static macOS arm64 and x64 builds with a SHA-256 next to each file and a `versions.txt` showing the configure line. His builds include libx264, libx265, libvpx and VideoToolbox. Each tool is a separate zip, so ffmpeg and ffprobe are two archives.
- **Martin Riedl's Linux builds were rejected.** They are configured with `--enable-nonfree` (DeckLink), which makes the binaries non-redistributable, so they are not GPL builds.
- **BtbN (Linux, Windows).** These are the builds linked from ffmpeg.org. They are static, the `gpl` variant includes libx264, libvpx, NVENC (ffnvcodec), VAAPI and AMF, and GitHub publishes a SHA-256 digest for each asset. Daily autobuilds are pruned, but the last autobuild of each month is kept (back to 2024-10 when this was pinned). Always pin a month-end autobuild.
- **gyan.dev (Windows) was not chosen.** Its `essentials` build has no NVENC, and its `full` build is larger than BtbN's for no gain here.

Verified when pinning (2026-09-29): every SHA-256 matched the published value, each archive layout was listed, the configure line of each Linux and Windows `ffmpeg` was read from the binary, and the darwin-arm64 build was run (`-encoders` and `-decoders` list libx264, libvpx-vp9 encode and decode, and VideoToolbox; its outputs are the test fixtures in `packages/core/test/fixtures/`). Since then the Real binaries workflow downloads and runs every pin (see [Re-pinning](#re-pinning)).

### Licence obligations

We do not redistribute these binaries: the user's machine downloads them from the builder. SPEC §9 plans a mirror on Frameshell GitHub Releases. Mirroring is redistribution, so under GPL-3.0 the mirror must also offer the corresponding source (FFmpeg plus every enabled library at the exact versions, and the build scripts), or a written offer for it. Set that up before adding a mirror URL.

## whisper.cpp (`whisper-cli`) and its models

Used by the official `@frameshell/whisper-cpp` transcription plugin (ADR 0003). The version is pinned because DTW and VAD behaviour change between commits.

Pin: **v1.9.4**, commit `927cfce34f31707e17f2bff35c349632fb9e2c3a` (upstream release `b5130`). The ADR 0003 spike measured commit `6e4ab854` (182 commits later, same lib version). Between the two, `src/whisper.cpp` changed only in an optional Apple Neural Engine encoder, a language-detection abort callback, a VAD model-load check and a chunk-offset overflow fix, and `examples/cli` only in error handling: nothing on the DTW or token timestamp path.

Every platform prefers a GPU build and falls back to CPU (SPEC §9). Candidates in order:

| Platform | Candidate | Chosen when | Asset | Licence |
|---|---|---|---|---|
| darwin-arm64, darwin-x64 | **Metal**, built locally from the pinned source tarball (`codeload.github.com/…/tar.gz/<commit>`, 9.4 MB): CMake, Metal on, Metal library embedded, static, only `whisper-cli` | always (only candidate) | — | MIT |
| linux-x64, linux-arm64 | **CUDA**, built locally from the same tarball (`-DGGML_CUDA=ON -DGGML_NATIVE=OFF`, static) | `nvidia-smi -L`, `nvcc --version` and `cmake --version` succeed | — | MIT |
| linux-x64, linux-arm64 | **Vulkan**, built locally from the same tarball (`-DGGML_VULKAN=ON -DGGML_NATIVE=OFF`, static) | `vulkaninfo --summary`, `glslc --version` and `cmake --version` succeed | — | MIT |
| linux-x64 | CPU, upstream release asset (ggml picks the best of 14 CPU variants at runtime) | otherwise | `whisper-bin-ubuntu-x64.tar.gz` (9.8 MB) | MIT |
| linux-arm64 | CPU, upstream release asset | otherwise | `whisper-bin-ubuntu-arm64.tar.gz` (4.6 MB) | MIT |
| win32-x64 | **CUDA 12.4**, upstream release asset | `nvidia-smi -L` succeeds | `whisper-cublas-12.4.0-bin-x64.zip` (675 MB, 1.2 GB unpacked) | MIT (CUDA runtime DLLs: NVIDIA CUDA EULA, redistributable) |
| win32-x64 | CPU, upstream release asset | otherwise | `whisper-bin-x64.zip` (8.6 MB) | MIT |
| win32-arm64 | CPU, upstream release asset | always | `whisper-bin-win-cpu-arm64.zip` (4.4 MB) | MIT |

Why each source:

- **Upstream ships no macOS command-line build.** Its macOS artefact is `whisper-*-xcframework.zip`, a library for apps. Homebrew's `whisper-cpp` floats with Homebrew and links Homebrew's `ggml`, so it cannot be pinned.
- **So macOS builds from source, pinned by commit and SHA-256.** This is the most robust option available today: it needs nothing Frameshell does not control except the toolchain, it gets Metal with the shaders embedded in one static executable, and it builds the exact pinned commit. Cost: the user needs the Xcode Command Line Tools and CMake (`xcode-select --install`, `brew install cmake`). The build looks for `cmake` on PATH, then `/opt/homebrew/bin`, `/usr/local/bin` and `CMake.app` (a daemon started by the app gets launchd's short PATH). Without CMake the install fails before downloading anything and says what to install, or how to point `binaries.whisper-cli` at an existing build.
- **Planned replacement (#27): Frameshell GitHub Release builds.** CI builds the same commit with the same flags on macOS runners (signed and notarized), and can do the same for Linux CUDA and Vulkan. The manifest then pins those assets first, keeping the source builds as the fallback. whisper.cpp is MIT, so redistribution only needs the licence notice. Until #27 ships, the source builds are the pins.
- **Windows x64 with an NVIDIA GPU: upstream's CUDA 12.4 build.** It is self-contained: `ggml-cuda.dll` imports `cudart64_12.dll` and `cublas64_12.dll` (which loads `cublasLt64_12.dll`), all shipped in the zip and installed next to `whisper-cli.exe`; only `nvcuda.dll` comes from the NVIDIA driver. The CUDA 11.8 asset was rejected: it ships no cuBLAS, so it needs a system CUDA 11 toolkit. Upstream builds load ggml backends at run time (`GGML_BACKEND_DL`), so the CUDA build also carries every CPU variant: without a usable GPU, ggml runs on CPU.
- **Linux: upstream publishes CPU builds only.** So with an NVIDIA GPU and the CUDA toolkit, or a Vulkan driver plus `glslc`, the pinned commit is built locally. `GGML_NATIVE=OFF` because `-march=native` breaks the CPU backend with some compiler/CPU pairs (gcc 12 in an arm64 VM); CUDA then compiles ggml's default architecture list, so the build takes 10 to 30 minutes, once. The Vulkan build also needs the SPIR-V headers (`spirv-headers`) and Vulkan headers new enough for `VK_EXT_layer_settings` (Debian 13 / Ubuntu 24.04; Debian 12's 1.3.239 fails). A failed or non-starting build falls back to the CPU asset, see "How it works". The CUDA build links the toolkit's shared `libcudart`/`libcublas`; if they cannot be loaded at run time, the start check fails and the Vulkan or CPU build is used instead.
- **Windows arm64: CPU only.** Upstream's `whisper-bin-win-cuda-13.4-arm64.zip` imports `nvcudart_hybrida64.dll`, which it does not ship, and `whisper-bin-win-opencl-adreno-arm64.zip` is an OpenCL backend (neither CUDA nor Vulkan) with partial op coverage. Neither can be verified here; users can build whisper.cpp themselves and set `binaries.whisper-cli`.
- **CPU assets:** the Linux libraries have `RUNPATH=$ORIGIN`, so they are installed next to `whisper-cli` under their SONAME (`libwhisper.so.1`, `libggml.so.0`, `libggml-base.so.0`). The Linux x64 build needs glibc 2.34 or newer (Ubuntu 22.04+). The Windows builds need the Microsoft Visual C++ 2015-2022 Redistributable (`MSVCP140.dll`).
- **CPU fallback at run time.** If `whisper-cli` fails after a GPU backend started (driver error, out of GPU memory), the provider reruns it once with `-ng` (CPU) and says so in progress. Without a usable GPU device, whisper.cpp itself logs `no GPU found` and runs on CPU.

Measured on an Apple M3 (8 GB), macOS 26.3, 11 s of speech (whisper.cpp's `samples/jfk.wav`), q5_0 model:

| Step | Time |
|---|---|
| Source download (codeload, 9.4 MB) | up to 18 s (codeload generates the tarball on demand) |
| CMake configure + build of `whisper-cli` | 23 to 28 s |
| **Metal shader compile, cold cache** | **14.6 s, 15.6 s, 21.4 s** (three installs) |
| Metal shader load, warm cache | 0.013 to 0.023 s |
| Whole transcription, warm | 2.2 s |
| Whole first transcription after install (model already downloaded) | 70 s |

The Metal compiler caches per executable path, so every new install (new version or data dir) is cold again. This is noticeable, so the provider announces it while it happens ("Compiling Metal GPU shaders (first run after install only, 15-25 s)") and reports the time afterwards. A warm-up step at install time is not possible: shaders compile when a model is loaded.

Models (Hugging Face `ggerganov/whisper.cpp`, revision `5359861c739e955e79d9a303bcbc70fb988958b1`, MIT):

| Id | Size | SHA-256 |
|---|---|---|
| `ggml-large-v3-turbo-q5_0` (default) | 574 MB | `394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2` |
| `ggml-large-v3-turbo-q8_0` | 874 MB | `317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1` |
| `ggml-large-v3-turbo` (f16) | 1.62 GB | `1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69` |

Verified when pinning (2026-09-29): every upstream asset's SHA-256 matched GitHub's published digest and was listed (`tar -tf`, `unzip -l`); the Linux libraries' `$ORIGIN` RUNPATH and the Windows DLL imports (CPU and CUDA builds) were read from the binaries; the source tarball hashed the same from `github.com/…/archive/` and `codeload`; the q5_0 model hash matched Hugging Face's LFS oid; the darwin-arm64 source build was installed by the manager and transcribed real speech (`FRAMESHELL_TEST_REAL_WHISPER=1`). The linux-arm64 Vulkan candidate was installed by the manager in a Debian 13 container with lavapipe (4 GB, so one compile job): probes passed, the build passed its start check, links only the system `libvulkan.so.1`, and with no GPU device (lavapipe is a CPU device, which ggml skips) it logged `no GPU found` and transcribed on CPU. In Debian 12 the same candidate failed (old Vulkan headers) and the manager fell back to the CPU asset as designed. The Windows builds and the Linux CUDA build were not executed (no NVIDIA GPU here; ticket #45 adds CI for Linux and Windows).

Re-pin whisper.cpp:

1. Pick a release tag and its `b<N>` release. Check `git log <old>..<new> -- src/whisper.cpp examples/cli` for changes to DTW, token timestamps or VAD; if any, re-run the ADR 0003 spike first.
2. Record asset sizes and digests: `gh release view b<N> -R ggml-org/whisper.cpp --json assets`. List each archive and update `files` and `support` (library names and SONAMEs change with ggml versions).
3. For the source builds (macOS, Linux CUDA and Vulkan), hash `https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/<commit>` and update `root`. For the Windows CUDA asset, read `ggml-cuda.dll`'s imports again and update the shipped CUDA DLL names.
4. Run `FRAMESHELL_TEST_REAL_WHISPER=1 pnpm test` on each platform you can reach (`FRAMESHELL_TEST_DATA_DIR=<dir>` keeps the 574 MB model between runs).

## Re-pinning ffmpeg

1. Pick a release build: for Martin Riedl, the "Release Build" section; for BtbN, the last autobuild of a month and the `n<major>.<minor>` `gpl` (not `gpl-shared`) assets.
2. Record the size and SHA-256 of each archive: Martin Riedl publishes `<file>.sha256`, and for BtbN run `gh release view <tag> -R BtbN/FFmpeg-Builds --json assets`. Check them against your own download.
3. Check the configure line (`versions.txt`, or `strings ffmpeg | grep -- --enable-gpl`): it must have `--enable-gpl`, `--enable-libx264` and `--enable-libvpx`, and must not have `--enable-nonfree`.
4. List the archive (`tar -tf`) and update the member paths in `files`.
5. Update the manifest and this table, then run `FRAMESHELL_TEST_REAL_DOWNLOAD=1 pnpm test` on each platform you can reach. This opt-in test downloads the real pin, checks the version and the required codecs, then runs the binaries: it encodes H.264 and VP9-with-alpha clips, reads them back with `ffprobe`, and checks that the libvpx decoder keeps the alpha.
6. Open the PR. The [Real binaries](../.github/workflows/real-binaries.yml) workflow runs the same test on every pinned platform (macOS arm64 and x64, Linux x64 and arm64, Windows x64) for any PR that touches `packages/core/src/binaries/`. It also runs weekly, to catch a builder pruning a pinned asset, and on manual dispatch.
