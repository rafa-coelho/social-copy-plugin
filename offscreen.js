// =====================
// OFFSCREEN DOCUMENT — Fetches audio, decodes, resamples, and runs Whisper
// Runs in extension context — no CSP restrictions, Workers work freely
// =====================

let worker = null;

function getWorker() {
  if (worker) return worker;
  worker = new Worker("whisper-worker.js", { type: "module" });
  return worker;
}

function sendProgress(tabId, message) {
  if (!tabId) return;
  chrome.runtime.sendMessage({
    action: "whisperProgress",
    tabId: tabId,
    message: message
  }).catch(() => {});
}

function resampleTo16kMono(audioBuffer) {
  const targetSampleRate = 16000;
  const numSamples = Math.round(audioBuffer.duration * targetSampleRate);
  const result = new Float32Array(numSamples);

  const channels = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    channels.push(audioBuffer.getChannelData(c));
  }

  const ratio = audioBuffer.sampleRate / targetSampleRate;
  for (let i = 0; i < numSamples; i++) {
    const srcIdx = i * ratio;
    const srcIdxFloor = Math.floor(srcIdx);
    const srcIdxCeil = Math.min(srcIdxFloor + 1, audioBuffer.length - 1);
    const frac = srcIdx - srcIdxFloor;

    let sample = 0;
    for (let c = 0; c < channels.length; c++) {
      sample += channels[c][srcIdxFloor] * (1 - frac) + channels[c][srcIdxCeil] * frac;
    }
    result[i] = sample / channels.length;
  }

  return result;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action !== "offscreenTranscribe") return false;

  const tabId = message.tabId;

  // Do everything async
  (async () => {
    try {
      // 1. Fetch audio
      sendProgress(tabId, "Baixando áudio...");
      const response = await fetch(message.audioUrl);
      if (!response.ok) throw new Error("Audio fetch failed: " + response.status);
      const arrayBuffer = await response.arrayBuffer();

      // 2. Decode audio
      sendProgress(tabId, "Decodificando áudio...");
      const audioCtx = new OfflineAudioContext(1, 44100 * 120, 44100);
      const audioBuf = await audioCtx.decodeAudioData(arrayBuffer);

      // 3. Resample to 16kHz mono
      sendProgress(tabId, "Preparando áudio...");
      const pcm16k = resampleTo16kMono(audioBuf);

      // 4. Run Whisper via worker
      const w = getWorker();

      const lines = await new Promise((resolve, reject) => {
        w.onmessage = (e) => {
          const msg = e.data;
          if (msg.type === "result") {
            resolve(msg.lines);
          } else if (msg.type === "error") {
            reject(new Error(msg.message));
          } else if (msg.type === "status" || msg.type === "progress") {
            sendProgress(tabId, msg.message);
          }
        };
        w.onerror = (e) => reject(new Error(e.message || "Worker error"));

        w.postMessage({
          type: "transcribe",
          audioData: pcm16k,
          language: message.language || "portuguese"
        });
      });

      sendResponse({ success: true, lines: lines });
    } catch (err) {
      console.error("Offscreen transcription error:", err);
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true; // async response
});
