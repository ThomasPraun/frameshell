#!/usr/bin/env bash
# PROTOTYPE. Idempotent: builds whisper.cpp, fetches models, creates the faster-whisper venv.
# Everything lands in gitignored folders (vendor/, models/, .venv/). Nothing system-wide.
set -euo pipefail
cd "$(dirname "$0")/.."

WHISPER_CPP_COMMIT=6e4ab854f67f743900934a703d5603419384c961 # master on 2026-09-28, lib v1.9.4
HF=https://huggingface.co/ggerganov/whisper.cpp/resolve/main

mkdir -p vendor models
if [ ! -d vendor/whisper.cpp ]; then
  git clone -q https://github.com/ggml-org/whisper.cpp.git vendor/whisper.cpp
fi
if [ "$(git -C vendor/whisper.cpp rev-parse HEAD)" != "$WHISPER_CPP_COMMIT" ]; then
  git -C vendor/whisper.cpp fetch -q --depth 1 origin "$WHISPER_CPP_COMMIT"
  git -C vendor/whisper.cpp checkout -q "$WHISPER_CPP_COMMIT"
fi
if [ ! -x vendor/whisper.cpp/build/bin/whisper-cli ]; then
  # Metal build. Same binary serves CPU runs via `-ng`.
  cmake -S vendor/whisper.cpp -B vendor/whisper.cpp/build -DGGML_METAL=ON -DCMAKE_BUILD_TYPE=Release
  cmake --build vendor/whisper.cpp/build -j 8 --config Release
fi

for m in large-v3-turbo large-v3-turbo-q5_0 large-v3-turbo-q8_0; do
  [ -f "models/ggml-$m.bin" ] || curl -fSL -o "models/ggml-$m.bin" "$HF/ggml-$m.bin"
done
[ -f models/ggml-silero-v5.1.2.bin ] || curl -fSL -o models/ggml-silero-v5.1.2.bin \
  https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin

if [ ! -x .venv/bin/python ]; then
  uv venv -q .venv --python 3.12
  VIRTUAL_ENV=.venv uv pip install -q faster-whisper==1.2.1
fi
# Same weights as ggml large-v3-turbo, CTranslate2 format.
HF_HOME=models/hf .venv/bin/python -c "from faster_whisper.utils import download_model; download_model('large-v3-turbo')"
echo "setup ok"
