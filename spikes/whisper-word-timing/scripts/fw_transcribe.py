"""PROTOTYPE. faster-whisper word timestamps -> JSON. Usage: fw_transcribe.py AUDIO OUT COMPUTE_TYPE THREADS"""
import json
import sys
import time
import wave

import numpy as np

from faster_whisper import WhisperModel

audio, out, compute_type, threads = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])

t0 = time.perf_counter()
# CTranslate2 has no Metal backend: CPU only on macOS.
model = WhisperModel("large-v3-turbo", device="cpu", compute_type=compute_type, cpu_threads=threads)
t1 = time.perf_counter()
# beam_size 5 matches whisper-cli default. No VAD: same input as whisper.cpp.
# Fixtures are 16 kHz mono s16 WAV. Decode here: the PyAV pulled by faster-whisper 1.2.1
# rejects its `metadata_errors` kwarg.
with wave.open(audio) as w:
    pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
segments, info = model.transcribe(pcm, language="es", beam_size=5, word_timestamps=True, vad_filter=False)
words = []
for seg in segments:
    for w in seg.words or []:
        words.append({"text": w.word, "start": round(w.start, 3), "end": round(w.end, 3), "p": round(w.probability, 4)})
t2 = time.perf_counter()

json.dump(
    {"engine": "faster-whisper", "computeType": compute_type, "loadSec": t1 - t0, "transcribeSec": t2 - t1, "audioSec": info.duration, "words": words},
    open(out, "w"),
    ensure_ascii=False,
)
print(f"{out}: load {t1 - t0:.1f}s transcribe {t2 - t1:.1f}s audio {info.duration:.1f}s words {len(words)}")
