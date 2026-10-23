# Managed binaries

frameshelld downloads native tools on first use instead of bundling them (SPEC §9). This page records which builds are pinned, where they come from, their licences, and how to re-pin. The manifest itself is `packages/core/src/binaries/manifest.ts`.

## How it works

- Pins are per platform (`<os>-<arch>`): version, URLs (the builder's canonical URL first, then Frameshell's mirror; the manager tries the next URL on a network error or a checksum mismatch), SHA-256, size, and the path of each executable inside the archive.
- A platform can pin several candidates in preference order (GPU first). An optional candidate names its `accelerator` and `requires` machine probes (commands that must exit 0, e.g. `nvidia-smi -L`). The manager takes the first candidate whose probes all pass. The last candidate has no probes: it is the CPU fallback. Probes run once per daemon. Optional candidates install beside the default one, in `<platform>-<accelerator>/`.
- An optional candidate's executables must answer the package's version probe (`whisper-cli --version`) before the install is published. If one does not start (runtime library or C library too old), the manager writes `<platform>-<accelerator>.failed.json` (with the error) next to its install dir, reports it as progress, and installs the next candidate. That candidate is skipped until the file is deleted. A download or checksum failure never falls back.
- Install location: `<dataDir>/binaries/<package>/<version>/<platform>/`, with an `install.json` recording the source URL, checksum and licence. See [User directories](#user-directories) for `dataDir`.
- Install steps: download to a private staging directory while hashing, abort on checksum mismatch, extract only the pinned members with the system `tar`, then publish with one directory rename. A failed install leaves nothing behind. Concurrent requests share one download.
- Extraction uses the system `tar`: bsdtar on macOS and Windows (`%SystemRoot%\System32\tar.exe`) reads zip and tar; GNU tar on Linux needs `xz` for `.tar.xz`. GNU tar reads no zip, so zip archives on Linux go through Frameshell's own reader (`binaries/unzip.ts`: stored and deflate, unix modes, no zip64).
- A pin may name a `tree`: a directory of the archive installed whole, keeping sub-paths, for tools that load data files from their own directory (headless Chrome).
- `support` members (shared libraries, licences) are placed next to the tools under the name the pin gives them, so shared libraries sit under their SONAME and no symlinks are needed.
- Every pin is a prebuilt download (SPEC §9). Nothing is compiled on the user's machine.
- Models (`<dataDir>/models/<id>/<revision>/<file>`) are single files pinned by URL, revision and SHA-256, downloaded on first use the same way.
- A `module` package installs ES modules the daemon imports instead of executables (ONNX Runtime Web): each tool lands as `<tool>.mjs`, with no exec bit and no version probe; `doctor` reports a managed install at its pinned version.
- Long installs report progress (download percent). `frameshell transcribe` prints it on stderr.
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

### Mirror and licence obligations

The user's machine downloads from the builder first. Every archive also lists a mirror URL: the GitHub release `ffmpeg-mirror-2026-09-29` in this repository (`FFMPEG_MIRROR` in the manifest). It holds the same bytes, so the pinned SHA-256 still applies.

Mirroring is redistribution of GPL-3.0 binaries, so the same release also carries (SPEC §9):

| Asset | Content |
|---|---|
| `source-ffmpeg-9.0.2.tar.xz` | FFmpeg 9.0.2 release source, for the macOS builds |
| `source-martin-riedl-build-script-6a611e1.tar.gz` | Martin Riedl's build scripts at `6a611e1`: configure flags, and every library version under `version/` |
| `source-ffmpeg-e47273f4d9.tar.gz` | FFmpeg at commit `e47273f4d9` (`n9.0.1-11`), for the Linux and Windows builds |
| `source-btbn-ffmpeg-builds-8267213.tar.gz` | BtbN FFmpeg-Builds at `8267213` (the commit of tag `autobuild-2026-08-31-13-27`): every library repository and commit under `scripts.d/` |
| `SOURCE-OFFER.txt` | Written offer, valid at least three years, for the complete corresponding source of every linked library. Requests arrive as issues titled `Source request: <tag>`. |
| `COPYING.GPLv3` | Licence text, taken from the FFmpeg source |
| `SHA256SUMS.txt` | SHA-256 of every file above and of every binary |

The source pins are `sources` of each build in the manifest, with SHA-256. How the revisions were matched: Riedl's `versions.txt` lists the same library versions as the `version/` files at `6a611e1`, which was the head of his `develop` branch when the 9.0.2 builds ran (2026-09-20). BtbN tags each autobuild on the commit it built, and its binaries report FFmpeg `e47273f4d9`.

A source request must be answered: the build scripts say where each library comes from and at which version.

`.github/workflows/binaries-mirror.yml` publishes the release:

- Pull request that changes the pins or the mirror code: downloads every binary and source, checks sizes and SHA-256, and publishes nothing.
- Push to `main` with such a change, or **Actions → Binary mirror → Run workflow** on `main`: if the tag has no published release, it stages the files and creates the release (as a draft first, published once every upload finished). Then it checks the published `SHA256SUMS.txt` against the manifest and that every mirror URL resolves.
- A published mirror is never changed. If the pins change while the tag stays the same, the check fails.

The release workflow runs the same check before it drafts an app release, so an app is never released while its mirror URLs are missing or stale.

Run it locally (needs `pnpm build`, downloads about 560 MB):

```sh
node packages/core/scripts/binaries-mirror.mjs stage ffmpeg /tmp/mirror /tmp/notes.md
node packages/core/scripts/binaries-mirror.mjs verify ffmpeg
```

## whisper.cpp (`whisper-cli`) and its models

Used by the official `@frameshell/whisper-cpp` transcription plugin (ADR 0003). The version is pinned because DTW and VAD behaviour change between commits.

Pin: **v1.9.4**, commit `927cfce34f31707e17f2bff35c349632fb9e2c3a` (upstream release `b5130`). The ADR 0003 spike measured commit `6e4ab854` (182 commits later, same lib version). Between the two, `src/whisper.cpp` changed only in an optional Apple Neural Engine encoder, a language-detection abort callback, a VAD model-load check and a chunk-offset overflow fix, and `examples/cli` only in error handling: nothing on the DTW or token timestamp path.

Every platform prefers a GPU build and falls back to CPU (SPEC §9). Every candidate is prebuilt and pinned by SHA-256. Candidates in order:

| Platform | Candidate | Chosen when | Asset | Licence |
|---|---|---|---|---|
| darwin-arm64, darwin-x64 | **Metal**, Frameshell build (see below): Metal library embedded, static, only `whisper-cli`. Also carries ggml's CPU backend | always (only candidate) | `whisper-cli-1.9.4-darwin-<arch>-metal.tar` on release `whisper-cpp-1.9.4-fs1` | MIT |
| linux-x64, linux-arm64 | **Vulkan**, Frameshell build (`-DGGML_VULKAN=ON -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF`, static) | `vulkaninfo --summary` succeeds; on x64 also `grep -qw avx2 /proc/cpuinfo` | `whisper-cli-1.9.4-linux-<arch>-vulkan.tar` on the same release | MIT |
| linux-x64 | CPU, upstream release asset (ggml picks the best of 14 CPU variants at runtime) | otherwise | `whisper-bin-ubuntu-x64.tar.gz` (9.8 MB) | MIT |
| linux-arm64 | CPU, upstream release asset | otherwise | `whisper-bin-ubuntu-arm64.tar.gz` (4.6 MB) | MIT |
| win32-x64 | **CUDA 12.4**, upstream release asset | `nvidia-smi -L` succeeds | `whisper-cublas-12.4.0-bin-x64.zip` (675 MB, 1.2 GB unpacked) | MIT (CUDA runtime DLLs: NVIDIA CUDA EULA, redistributable) |
| win32-x64 | CPU, upstream release asset | otherwise | `whisper-bin-x64.zip` (8.6 MB) | MIT |
| win32-arm64 | CPU, upstream release asset | always | `whisper-bin-win-cpu-arm64.zip` (4.4 MB) | MIT |

Why each source:

- **Upstream ships no macOS command-line build.** Its macOS artefact is `whisper-*-xcframework.zip`, a library for apps. Homebrew's `whisper-cpp` floats with Homebrew and links Homebrew's `ggml`, so it cannot be pinned. **Upstream ships no Linux GPU build** either.
- **So Frameshell builds those targets in CI and publishes them on its own GitHub release** (`.github/workflows/whisper-cpp-release.yml`, script `packages/core/scripts/whisper-cpp-build.mjs`, recipes `WHISPER_FRAMESHELL_BUILDS` in the manifest). The input is the pinned source tarball (`codeload.github.com/…/tar.gz/<commit>`, 9.4 MB, SHA-256 pinned). The user needs no toolchain. whisper.cpp is MIT, so redistribution only needs the licence notice, which is inside each archive.
- **The builds are reproducible, and CI enforces it.** Each asset is an uncompressed tar packed without timestamps or owners (`packTar`), built with source and build paths remapped (`-ffile-prefix-map`), no native CPU tuning, and a fixed toolchain (runner image in the manifest, Xcode 16.4 on macOS). Every workflow run rebuilds every asset and fails unless the bytes equal the pin. On `main` the release is created once from those checked bytes, and an existing release is only verified, never changed. So the pinned bytes are what the recipe produces from the pinned source, and anyone can rebuild them.
- **Not code-signed yet.** The binary manager downloads with Node, which sets no quarantine attribute, so Gatekeeper does not check it, and the arm64 linker's ad-hoc signature is enough to run. Signing with the Frameshell Developer ID belongs to release packaging (#27); a signature is not reproducible, so signed assets will be pinned from the published release instead.
- **macOS x64 is cross-compiled** on the Apple silicon runner with `GGML_NATIVE=OFF` and AVX/AVX2/FMA/F16C on (every Intel Mac that runs macOS 13, the deployment target, has AVX2). Its start check runs under Rosetta.
- **Linux Vulkan** covers NVIDIA, AMD and Intel GPUs with one build. It links only the system `libvulkan.so.1`, `libstdc++` and glibc; it is built on Ubuntu 24.04 (Vulkan headers new enough for `VK_EXT_layer_settings`), so it needs glibc 2.38 (Ubuntu 24.04, Debian 13). On older systems its start check fails and the manager installs the CPU asset. `GGML_NATIVE=OFF` because `-march=native` makes the bytes depend on the CI machine and broke the CPU backend with gcc 12 in an arm64 VM; ggml then targets AVX2 on x64, hence the AVX2 probe. No Linux CUDA build is pinned: a prebuilt one would have to ship the CUDA runtime and cuBLAS (about 700 MB); Vulkan runs on NVIDIA GPUs too.
- **Windows x64 with an NVIDIA GPU: upstream's CUDA 12.4 build.** It is self-contained: `ggml-cuda.dll` imports `cudart64_12.dll` and `cublas64_12.dll` (which loads `cublasLt64_12.dll`), all shipped in the zip and installed next to `whisper-cli.exe`; only `nvcuda.dll` comes from the NVIDIA driver. The CUDA 11.8 asset was rejected: it ships no cuBLAS, so it needs a system CUDA 11 toolkit. Upstream builds load ggml backends at run time (`GGML_BACKEND_DL`), so the CUDA build also carries every CPU variant: without a usable GPU, ggml runs on CPU.
- **Windows arm64: CPU only.** Upstream's `whisper-bin-win-cuda-13.4-arm64.zip` imports `nvcudart_hybrida64.dll`, which it does not ship, and `whisper-bin-win-opencl-adreno-arm64.zip` is an OpenCL backend (neither CUDA nor Vulkan) with partial op coverage. Neither can be verified here; users can build whisper.cpp themselves and set `binaries.whisper-cli`.
- **CPU assets:** the Linux libraries have `RUNPATH=$ORIGIN`, so they are installed next to `whisper-cli` under their SONAME (`libwhisper.so.1`, `libggml.so.0`, `libggml-base.so.0`). The Linux x64 build needs glibc 2.34 or newer (Ubuntu 22.04+). The Windows builds need the Microsoft Visual C++ 2015-2022 Redistributable (`MSVCP140.dll`).
- **CPU fallback at run time.** If `whisper-cli` fails after a GPU backend started (driver error, out of GPU memory), the provider reruns it once with `-ng` (CPU) and says so in progress. Without a usable GPU device, whisper.cpp itself logs `no GPU found` and runs on CPU.

Measured on an Apple M3 (8 GB), macOS 26.3, 11 s of speech (whisper.cpp's `samples/jfk.wav`), q5_0 model, with a Metal build of the same recipe:

| Step | Time |
|---|---|
| **Metal shader compile, cold cache** | **14.6 s, 15.6 s, 21.4 s** (three installs) |
| Metal shader load, warm cache | 0.013 to 0.023 s |
| Whole transcription, warm | 2.2 s |

The Metal compiler caches per executable path, so every new install (new version or data dir) is cold again. This is noticeable, so the provider announces it while it happens ("Compiling Metal GPU shaders (first run after install only, 15-25 s)") and reports the time afterwards. A warm-up step at install time is not possible: shaders compile when a model is loaded.

Models (Hugging Face `ggerganov/whisper.cpp`, revision `5359861c739e955e79d9a303bcbc70fb988958b1`, MIT):

| Id | Size | SHA-256 |
|---|---|---|
| `ggml-large-v3-turbo-q5_0` (default) | 574 MB | `394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2` |
| `ggml-large-v3-turbo-q8_0` | 874 MB | `317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1` |
| `ggml-large-v3-turbo` (f16) | 1.62 GB | `1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69` |

Verified when pinning (2026-09-29): every upstream asset's SHA-256 matched GitHub's published digest and was listed (`tar -tf`, `unzip -l`); the Linux libraries' `$ORIGIN` RUNPATH and the Windows DLL imports (CPU and CUDA builds) were read from the binaries; the source tarball hashed the same from `github.com/…/archive/` and `codeload`; the q5_0 model hash matched Hugging Face's LFS oid. Frameshell builds (2026-09-30): the darwin-arm64 build was reproduced byte for byte on one Mac in two different directories; each asset's pin is the CI output, and the next CI run rebuilt the same bytes. The CI darwin-arm64 asset was installed by the manager from a local server and transcribed real speech on Metal (22 words, "ask" at 3.78 s, as with earlier builds). The Linux x64 Vulkan executable needs only `libvulkan.so.1`, `libstdc++`, `libgcc_s`, `libm` and glibc 2.38 (read from the binary); both Linux builds passed their start check on the CI runner. An earlier local Vulkan build of the same commit transcribed in a Debian 13 container with lavapipe (a CPU device, which ggml skips: it logged `no GPU found` and ran on CPU). Not executed: the Frameshell Vulkan builds on a real GPU, the Windows builds and the darwin-x64 build on an Intel Mac (its start check ran under Rosetta); ticket #45 adds CI for Linux and Windows.

Re-pin whisper.cpp:

1. Pick a release tag and its `b<N>` release. Check `git log <old>..<new> -- src/whisper.cpp examples/cli` for changes to DTW, token timestamps or VAD; if any, re-run the ADR 0003 spike first.
2. Record asset sizes and digests: `gh release view b<N> -R ggml-org/whisper.cpp --json assets`. List each archive and update `files` and `support` (library names and SONAMEs change with ggml versions).
3. For the Windows CUDA asset, read `ggml-cuda.dll`'s imports again and update the shipped CUDA DLL names.
4. Frameshell builds: hash `https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/<commit>` into `WHISPER_SOURCE`, bump `WHISPER_FRAMESHELL_TAG` (a published release is never changed), and set each `WHISPER_FRAMESHELL_BUILDS` hash to 64 zeros and size 0. Push a PR: the `whisper.cpp release builds` workflow builds every asset and fails, printing each asset's SHA-256 and size. Pin those and push again: the next run rebuilds and must match, which proves the build reproducible. A changed toolchain (runner image, Xcode, apt packages) changes the bytes the same way: re-pin. After merge, the workflow publishes the release from `main`.
5. Run `FRAMESHELL_TEST_REAL_WHISPER=1 pnpm test` on each platform you can reach (`FRAMESHELL_TEST_DATA_DIR=<dir>` keeps the 574 MB model between runs).

## Headless Chrome (`chrome-headless-shell`)

Used by the official `@frameshell/hyperframes` plugin: `@hyperframes/producer` renders compositions in it, found through `PRODUCER_HEADLESS_SHELL_PATH` (ADR 0002). On demand: the first HyperFrames render installs it; `doctor` lists it but never reports it missing.

Pin: **Chrome for Testing 154.0.8037.57**, the build ADR 0002 measured, from Google's `chrome-for-testing-public` bucket. Each archive is a zip with one top directory (`chrome-headless-shell-<target>/`), installed whole (`tree`): the executable loads its `.pak`, ICU and SwiftShader files from beside it.

| Platform | Target | Size | SHA-256 |
|---|---|---|---|
| darwin-arm64 | `mac-arm64` | 99.5 MB | `9ba4d8a9732bd7e431ce9009d1bbe1ccf7f8c5de2a9781054f500a9fe898124d` |
| darwin-x64 | `mac-x64` | 104.7 MB | `b3f9551d90c9ff0f4c7c231a4dbf226b3c64faba8ced1ab61a5ef9d430d0e996` |
| linux-x64 | `linux64` | 120.5 MB | `5a6979d0ab7cf952ea575d35164e7bdce4872b2ced8f8a215c8f8e8eda00ee09` |
| win32-x64 | `win64` | 120.9 MB | `bcc91b4d0f83a5457fc6ca7941fd65f2349775523d961be88526c6a66560dc75` |

- Google publishes no Linux arm64 or Windows arm64 build: set `binaries.chrome-headless-shell` to a local Chromium headless shell there.
- Licence: Chromium's BSD-3-Clause plus the third-party notices in `LICENSE.headless_shell`; the binary is Google's, under the Chrome terms. Frameshell never redistributes it: the user's machine downloads it from Google, as puppeteer does. No mirror.
- Verified when pinning (2026-09-30): each archive's MD5 matched the `x-goog-hash` Google's bucket publishes, each was listed (16 files on macOS, 287 on Linux, 288 on Windows, all under the one top directory), the darwin-arm64 executable printed `Google Chrome for Testing 154.0.8037.57` from a manager install, and the Linux zip extracted by `extractZip` matched `unzip` byte for byte. `FRAMESHELL_TEST_REAL_DOWNLOAD=1` installs and runs the pin; `FRAMESHELL_TEST_REAL_HYPERFRAMES=1` renders a composition with it.
- Re-pin: pick a Chrome for Testing version (`https://googlechromelabs.github.io/chrome-for-testing/known-good-versions.json`), download each `chrome-headless-shell-<target>.zip`, record size and SHA-256 (check the MD5 against the bucket's `x-goog-hash` header), then run the two opt-in tests above.

## Speaker diarization (sherpa-onnx) and its models

Used by `transcribe.speakers` (ADR 0016 decision 3: who speaks when people share a mic). On demand: the first `frameshell transcribe --speakers` installs it; `doctor` lists it but never reports it missing. The tool prints no version, so `doctor` shows `sherpa-onnx` where other tools show a version.

Pin: **sherpa-onnx v1.13.8** (2026-09-10), upstream [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) release assets, `shared` CPU variants. Each `.tar.bz2` holds one top directory; the manager installs `bin/sherpa-onnx-offline-speaker-diarization` and the ONNX Runtime library it loads from its own directory (rpath `@loader_path` on macOS, `$ORIGIN` on Linux; the exe's directory on Windows).

| Platform | Asset | Size | SHA-256 | Runtime next to it |
|---|---|---|---|---|
| darwin-arm64 | `sherpa-onnx-v1.13.8-osx-arm64-shared.tar.bz2` | 20.3 MB | `b10e5c7e2c30ea03de9c442655d14860d9edc475c6251d58a8f5f06e913a1d56` | `libonnxruntime.dylib` |
| darwin-x64 | `sherpa-onnx-v1.13.8-osx-x64-shared.tar.bz2` | 22.8 MB | `54aad64acee9d2d596535a6080d6f22602a720af5460e1d50461b1e1b06bee40` | `libonnxruntime.dylib` |
| linux-x64 | `sherpa-onnx-v1.13.8-linux-x64-shared.tar.bz2` | 28.2 MB | `c0bdb7907d3a74bba1d55d22bf4d9fa75586cf1530614ebe88a27b9118e015c4` | `libonnxruntime.so` |
| linux-arm64 | `sherpa-onnx-v1.13.8-linux-aarch64-shared-cpu.tar.bz2` | 28.1 MB | `4e3734f82bc1379fd91f219f5869c7e9d03b7a4f7561907d8abca4849c51a789` | `libonnxruntime.so` |
| win32-x64 | `sherpa-onnx-v1.13.8-win-x64-shared-MT-Release.tar.bz2` | 24.8 MB | `6dffdc715a4465b989446a6105265d2cb345e7101591a17d35534b6758f6e8df` | `onnxruntime.dll`, `onnxruntime_providers_shared.dll` |
| win32-arm64 | `sherpa-onnx-v1.13.8-win-arm64-shared-MT-Release.tar.bz2` | 23.3 MB | `455ea18dc44aea188b4f7976037dea3d77e3f8d7afe0760f34244a7a0db53c4c` | `onnxruntime.dll`, `onnxruntime_providers_shared.dll` |

- **Licence:** Apache-2.0 (sherpa-onnx); ONNX Runtime, linked in, is MIT. Frameshell never redistributes them: the user's machine downloads from the builder's GitHub release. No Frameshell mirror, like whisper.cpp's upstream assets and models and headless Chrome; only ffmpeg is mirrored.
- **Why these assets:** `shared` builds are 20-28 MB against 180-540 MB for `static` ones, and need only the one runtime library beside the tool. On Windows the `MT` builds link the C runtime statically, so no Visual C++ redistributable is needed. On Linux the tool and its runtime need glibc 2.16 (x64) or 2.17 (arm64) and `libstdc++` (read from the binaries). CPU only: diarization of an hour takes minutes, not worth a GPU candidate.
- **Extraction:** the system `tar` reads `.tar.bz2`; on Linux GNU tar needs `bzip2`.

Models, from the Hugging Face repositories where sherpa-onnx's author publishes the ONNX exports, pinned by revision:

| Id | Model | Revision | Size | SHA-256 | Licence |
|---|---|---|---|---|---|
| `pyannote-segmentation-3-0` | [pyannote segmentation 3.0](https://huggingface.co/pyannote/segmentation-3.0) as `model.onnx` (`csukuangfj/sherpa-onnx-pyannote-segmentation-3-0`) | `9403a6902bb5` | 6.0 MB | `220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079` | MIT |
| `3dspeaker-campplus-en-voxceleb` | [3D-Speaker CAM++, VoxCeleb](https://modelscope.cn/models/iic/speech_campplus_sv_en_voxceleb_16k) (`csukuangfj/speaker-embedding-models`) | `0743f301363d` | 29.6 MB | `357a834f702b80161e5b981182c038e18553c1f2ca752ed6cec2052365d4129b` | Apache-2.0 |

The embedding model also lists sherpa-onnx's `speaker-recongition-models` release asset (same bytes) as a second URL. CAM++ trained on VoxCeleb was chosen over the Chinese-only 3D-Speaker models because VoxCeleb's speakers talk many languages; the licence of each model was read from its model card (Hugging Face `license: mit`; ModelScope `Apache License 2.0`).

Verified when pinning (2026-10-19): each archive was downloaded and its SHA-256 matched GitHub's published digest; each archive was listed and the members above found; the libraries each executable loads were read from it (only ONNX Runtime besides the system's); both model files hashed the same from Hugging Face (matching its LFS oid) and, for the embedding model, from the release asset (matching sherpa-onnx's `checksum.txt`). The darwin-arm64 pin was installed by the manager and diarized sherpa-onnx's `0-four-speakers-zh.wav` sample (57 s) in 2.3 s on an Apple M3 with 4 threads. `FRAMESHELL_TEST_REAL_DOWNLOAD=1` installs the pin and both models and runs them on every platform of the Real binaries workflow.

Re-pin: pick a release (`gh release view v<version> -R k2-fsa/sherpa-onnx --json assets` gives sizes and digests), download each asset and check its digest, list it (`tar -tjf`) and update the member paths, read each executable's library list again (`otool -L`, `readelf -d`, the PE imports), then run the opt-in test above.

## Face detection (ONNX Runtime Web) and its model

Used by `multicam.faces` (ADR 0016: reframe keys for 9:16 from faces) and `people.scan` (ADR 0020: who is on screen). On demand: the first `frameshell multicam faces` or `frameshell people scan` installs it; `doctor` lists it but never reports it missing.

Pin: **onnxruntime-web 1.30.0** (2026-09-14), Microsoft's npm tarball [`onnxruntime-web-1.30.0.tgz`](https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.30.0.tgz), 33.1 MB, SHA-256 `d2228df7e4616bc3348bf504ee888f3bec43789a273f0a63f3e68d203ce3bf71`, the same pin for every platform. The manager extracts four of its files: `dist/ort.wasm.min.mjs` (the CPU-only bundle with ONNX Runtime's JS API, installed as `onnxruntime-web.mjs`), the `ort-wasm-simd-threaded.mjs` loader and the `.wasm` it loads (14.2 MB), and the bundle's source map. A worker thread of the daemon imports the module and runs the model single-threaded as WebAssembly, off the daemon's event loop.

- **Why WebAssembly:** ONNX Runtime's GitHub releases ship libraries, not a program, and sherpa-onnx (the speaker diarization pin) has no tool that runs an arbitrary model. OpenCV publishes no macOS or Linux binaries, and the pinned ffmpeg builds have no `dnn` filters. A native loader for ONNX Runtime would be native code Frameshell compiles and signs, and `onnxruntime-node` is the same runtime as native addons for every platform, about 300 MB unpacked. The WebAssembly build needs nothing native: one tarball for every platform with Node, and YuNet takes about 20 ms per 512×288 frame on an Apple M3.
- **Licence:** MIT (ONNX Runtime; stated in the bundle's header and `package.json`, the tarball has no `LICENSE` file). Frameshell never redistributes it: the user's machine downloads it from the npm registry, where Microsoft publishes it. It is not a dependency of any Frameshell package. No mirror.
- **Extraction:** the system `tar` reads `.tgz` (GNU tar detects gzip itself).

Model, from OpenCV's model zoo, pinned by commit:

| Id | Model | Revision | Size | SHA-256 | Licence |
|---|---|---|---|---|---|
| `yunet-2026may` | [YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) `face_detection_yunet_2026may.onnx` (the 2023mar model re-exported with dynamic input height and width) | `26cc381e4d25` | 0.2 MB | `ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0` | MIT |
| `sface-2021dec` | [SFace](https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface) `face_recognition_sface_2021dec.onnx` (`people.scan`: a face aligned to 112×112 in, 128 numbers out) | `26cc381e4d25` | 38.7 MB (38,696,353 bytes) | `0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79` | Apache-2.0 |

The URL is on `media.githubusercontent.com` (the large-file object at that commit), where `github.com/opencv/opencv_zoo/raw/<commit>/…` redirects. The licence of each model is its directory's `LICENSE`: YuNet MIT (Shiqi Yu), SFace Apache-2.0 (not MIT). SFace's weights are Apache-2.0; the training sets named in the SFace paper are research face datasets (ADR 0020 decision 14). Everything runs locally; SFace downloads on the first `people scan` and is not mirrored.

SFace input, as OpenCV's `FaceRecognizerSF` feeds it: the face warped by the similarity transform that takes YuNet's five landmarks to the ArcFace template (`alignCrop`), bilinear, 112×112, RGB planes in 0..255 with no mean or scale (`blobFromImage` with `swapRB`). Output `fc1` `[1, 128]`, L2-normalized by Frameshell; cosine similarity above 0.363 is OpenCV's same-person line. The int8 export (9.9 MB) is not used: 2.5x slower per face in WebAssembly.

Verified when pinning (2026-10-22): the tarball's SHA-1 and SHA-512 matched the registry's `shasum` and `integrity`; it was listed and the four members found; the model hashed to its large-file oid. The manager installed both on darwin-arm64, and YuNet found the faces in OpenCV's `lena.jpg` and `messi5.jpg` samples and the drawn face of `packages/core/test/face-fixture.ts`. `FRAMESHELL_TEST_REAL_DOWNLOAD=1` installs both and keys a drawn face that moves, on every platform of the Real binaries workflow; it also installs SFace, checks YuNet's landmark order on a drawn face and runs `peopleScanWorker` over a 1280×720 video of that face moving (two tracks, a print per second, the two prints alike). SFace was pinned 2026-10-23: its large-file oid matched the SHA-256 on download.

Re-pin: `npm view onnxruntime-web@<version> dist` gives the tarball URL, `shasum` and `integrity`; download it, check both, record size and SHA-256, list it (`tar -tzf`) and check the four members still exist (a renamed WebAssembly file changes the `support` names), then run the opt-in test above. For the model, take the file's large-file oid at a newer commit and check that its outputs are still `cls_8`…`kps_32` (`decodeYunet`). SFace re-pins with it (same commit): check the input is still `[1, 3, 112, 112]` and the output 128 numbers, and that the landmark template in `people/scan.ts` is still OpenCV's.

## Re-pinning ffmpeg

1. Pick a release build: for Martin Riedl, the "Release Build" section; for BtbN, the last autobuild of a month and the `n<major>.<minor>` `gpl` (not `gpl-shared`) assets.
2. Record the size and SHA-256 of each archive: Martin Riedl publishes `<file>.sha256`, and for BtbN run `gh release view <tag> -R BtbN/FFmpeg-Builds --json assets`. Check them against your own download.
3. Check the configure line (`versions.txt`, or `strings ffmpeg | grep -- --enable-gpl`): it must have `--enable-gpl`, `--enable-libx264` and `--enable-libvpx`, and must not have `--enable-nonfree`.
4. List the archive (`tar -tf`) and update the member paths in `files`.
5. Pin the corresponding source (`sources`): the FFmpeg source at the exact revision and the builder's build scripts at the commit that produced the build, with size and SHA-256. Check that the scripts' library versions match the build (`versions.txt`, or the configure line).
6. Give `FFMPEG_MIRROR` a new `tag` (a published mirror is immutable), and keep mirror asset names unique: `planMirror` and `packages/core/test/mirror.test.ts` reject a build without source or an asset name used for two files.
7. Update the manifest and this table, then run `FRAMESHELL_TEST_REAL_DOWNLOAD=1 pnpm test` on each platform you can reach. This opt-in test downloads the real pin, checks the version and the required codecs, then runs the binaries: it encodes H.264 and VP9-with-alpha clips, reads them back with `ffprobe`, and checks that the libvpx decoder keeps the alpha.
8. Open the PR. The [Real binaries](../.github/workflows/real-binaries.yml) workflow runs the same test on every pinned platform (macOS arm64 and x64, Linux x64 and arm64, Windows x64) for any PR that touches `packages/core/src/binaries/`. It also runs weekly, to catch a builder pruning a pinned asset, and on manual dispatch.
