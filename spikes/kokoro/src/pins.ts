// Pinned files of the spike: Kokoro model variants, voices, tokenizer, misaki English dictionary.
import { join } from "node:path";
import { DOWNLOADS } from "./paths.ts";

export const KOKORO_REPO = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const KOKORO_REVISION = "1939ad2a8e416c0acfeecc08a694d14ef25f2231";
export const MISAKI_COMMIT = "fba1236595f2d2bf21d414ba6e57d25256afada3";

export interface Pinned { file: string; url: string; bytes: number; sha256: string | null }

export const hf = (file: string) => `https://huggingface.co/${KOKORO_REPO}/resolve/${KOKORO_REVISION}/${file}`;

/** Model variants: SHA-256 = the Hugging Face large-file oid at the revision. */
export const MODELS: Record<string, Pinned> = {
  fp32: { file: "onnx/model.onnx", url: hf("onnx/model.onnx"), bytes: 325_532_232, sha256: "8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb" },
  int8: { file: "onnx/model_quantized.onnx", url: hf("onnx/model_quantized.onnx"), bytes: 92_361_116, sha256: "fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478" },
  q8f16: { file: "onnx/model_q8f16.onnx", url: hf("onnx/model_q8f16.onnx"), bytes: 86_033_585, sha256: "04c658aec1b6008857c2ad10f8c589d4180d0ec427e7e6118ceb487e215c3cd0" },
  fp16: { file: "onnx/model_fp16.onnx", url: hf("onnx/model_fp16.onnx"), bytes: 163_234_740, sha256: "ba4527a874b42b21e35f468c10d326fdff3c7fc8cac1f85e9eb6c0dfc35c334a" },
};

export const VOICES: Record<string, string> = {
  ef_dora: "f66ec66bd295acb18372e37008533a9a3228483ccd294e7538d5d9294ac9a532",
  em_alex: "27809e9eafdcbcfff90a3016c697568676531de2a2c39cee29c96c7bd6b83e95",
  em_santa: "ad43b774e1ca24d05c6161297d8aeb770ac3d29bb95daf516727af5f7d543683",
  af_heart: "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b",
  am_michael: "1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1",
};

/** Small files are not large-file objects: no oid to pin, recorded by the hash printed on download. */
export const SMALL: Pinned[] = [
  { file: "tokenizer.json", url: hf("tokenizer.json"), bytes: 3497, sha256: null },
  {
    file: "misaki/us_gold.json",
    url: `https://raw.githubusercontent.com/hexgrad/misaki/${MISAKI_COMMIT}/misaki/data/us_gold.json`,
    bytes: 3_000_469,
    sha256: null,
  },
];

export function local(file: string): string {
  return join(DOWNLOADS, ...file.split("/"));
}

