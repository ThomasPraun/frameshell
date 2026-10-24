// Fetch the pinned whisper.cpp source (docs/binaries.md pin) and build whisper-server (resident-model HTTP server) with Metal.
// The managed whisper-cli (Frameshell release) is downloaded separately:
//   gh release download whisper-cpp-1.9.4-fs1 -R ThomasPraun/frameshell -p 'whisper-cli-1.9.4-darwin-arm64-metal.tar' -D bin/
//   mkdir -p bin/cli && tar -xf bin/whisper-cli-1.9.4-darwin-arm64-metal.tar -C bin/cli
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib.mjs';
const COMMIT = '927cfce34f31707e17f2bff35c349632fb9e2c3a';
const src = path.join(ROOT, 'bin/src'); mkdirSync(src, { recursive: true });
const sh = (c) => { console.log('$', c); const r = spawnSync('sh', ['-c', c], { stdio: 'inherit', cwd: ROOT }); if (r.status) process.exit(r.status); };
if (!existsSync(path.join(src, 'CMakeLists.txt'))) sh(`curl -sL https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/${COMMIT} | tar -xz -C bin/src --strip-components=1`);
sh('cmake -S bin/src -B bin/build -DCMAKE_BUILD_TYPE=Release -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_TESTS=OFF -DWHISPER_SDL2=OFF');
sh('cmake --build bin/build -j 8 --target whisper-server');
