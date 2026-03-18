// =====================
// WHISPER WORKER — Runs speech-to-text using Transformers.js (Whisper base)
// Uses ES module import (type: "module" worker)
// =====================

import { pipeline, env } from "./lib/transformers.min.js";

// URL absoluta para os arquivos WASM/MJS do ONNX Runtime.
// Precisa ser absoluta porque:
// - dynamic import(.mjs) resolve relativo ao transformers.min.js (em lib/)
// - fetch/XHR(.wasm) resolve relativo ao worker (na raiz)
// Com URL absoluta, ambos resolvem para o mesmo diretório correto.
env.backends.onnx.wasm.wasmPaths = new URL("./lib/", import.meta.url).href;

// Modelos continuam sendo buscados no HuggingFace (permitido por host_permissions)
env.allowRemoteModels = true;
env.allowLocalModels = false;

let pipe = null;
let isLoading = false;

async function initPipeline() {
  if (pipe) return pipe;
  if (isLoading) {
    while (isLoading) await new Promise(r => setTimeout(r, 100));
    return pipe;
  }

  isLoading = true;

  try {
    self.postMessage({ type: "status", message: "Carregando modelo Whisper..." });

    pipe = await pipeline(
      "automatic-speech-recognition",
      "Xenova/whisper-small",
      {
        dtype: "q8",
        device: "wasm",
        progress_callback: (progress) => {
          if (progress.status === "downloading") {
            const pct = progress.progress ? Math.round(progress.progress) : 0;
            self.postMessage({
              type: "progress",
              message: "Baixando modelo... " + pct + "%",
              progress: pct
            });
          } else if (progress.status === "loading") {
            self.postMessage({ type: "status", message: "Carregando modelo..." });
          }
        }
      }
    );

    self.postMessage({ type: "status", message: "Modelo carregado!" });
    return pipe;
  } catch (err) {
    self.postMessage({ type: "error", message: "Erro ao carregar modelo: " + err.message });
    throw err;
  } finally {
    isLoading = false;
  }
}

async function transcribe(audioData, language) {
  const p = await initPipeline();

  self.postMessage({ type: "status", message: "Transcrevendo..." });

  const result = await p(audioData, {
    language: language || "portuguese",
    task: "transcribe",
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
    no_repeat_ngram_size: 3,
    repetition_penalty: 1.2
  });

  return result;
}

self.onmessage = async function(e) {
  const { type, audioData, language } = e.data;

  if (type === "transcribe") {
    try {
      const result = await transcribe(audioData, language);

      const lines = [];
      if (result.chunks) {
        for (const chunk of result.chunks) {
          lines.push({
            startMs: Math.round((chunk.timestamp[0] || 0) * 1000),
            durationMs: Math.round(((chunk.timestamp[1] || chunk.timestamp[0] || 0) - (chunk.timestamp[0] || 0)) * 1000),
            text: chunk.text.trim()
          });
        }
      } else if (result.text) {
        lines.push({ startMs: 0, durationMs: 0, text: result.text.trim() });
      }

      self.postMessage({ type: "result", lines: lines });
    } catch (err) {
      self.postMessage({ type: "error", message: err.message });
    }
  }

  if (type === "preload") {
    try {
      await initPipeline();
    } catch (err) {}
  }
};
