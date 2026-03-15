// Always allow re-injection after extension reload
if (window.__igToolkitCleanup) {
  window.__igToolkitCleanup();
}

(function() {
  let lastRightClickTarget = window.__igToolkitLastTarget || null;
  let buttonContainer = null;
  let isDownloading = false;
  let intervalId = null;

  // Cleanup function for re-injection
  window.__igToolkitCleanup = function() {
    if (intervalId) clearInterval(intervalId);
    if (buttonContainer) buttonContainer.remove();
    buttonContainer = null;
  };

  // Safe wrapper: avoids "Extension context invalidated" errors
  function safeSendMessage(msg, callback) {
    try {
      if (!chrome.runtime?.id) return;
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) return;
        if (callback) callback(res);
      });
    } catch (e) {}
  }

  // =====================
  // IMAGE COPY
  // =====================
  document.addEventListener("contextmenu", (e) => {
    lastRightClickTarget = e.target;
    window.__igToolkitLastTarget = e.target;
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "copyImage") handleCopyImage();
  });

  function handleCopyImage() {
    let img = lastRightClickTarget ? findNearestImage(lastRightClickTarget) : null;
    if (!img) img = findMainPostImage();

    if (img && img.src) {
      safeSendMessage({ action: "fetchImage", url: img.src }, (res) => {
        if (res?.success) convertDataUrlToPngAndCopy(res.dataUrl);
        else showToast("Erro ao buscar imagem");
      });
    } else {
      showToast("Nenhuma imagem encontrada");
    }
  }

  function findNearestImage(el) {
    let cur = el;
    for (let i = 0; i < 15 && cur; i++) {
      if (cur.tagName === "IMG" && cur.src && (cur.naturalWidth > 200 || cur.width > 200)) return cur;
      const img = pickLargest(cur.querySelectorAll("img[src]"));
      if (img) return img;
      cur = cur.parentElement;
    }
    return null;
  }

  function findMainPostImage() {
    for (const article of document.querySelectorAll("article")) {
      const img = pickLargest(article.querySelectorAll("img[src]"));
      if (img) return img;
    }
    return pickLargest(document.querySelectorAll("img[src]"));
  }

  function pickLargest(imgs) {
    let best = null, bestArea = 0;
    for (const img of imgs) {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (w > 200 && w * h > bestArea) { best = img; bestArea = w * h; }
    }
    return best;
  }

  async function convertDataUrlToPngAndCopy(dataUrl) {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0);
      c.toBlob(async (blob) => {
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          showToast("Imagem copiada!");
        } catch { showToast("Erro ao copiar"); }
      }, "image/png");
    };
    img.src = dataUrl;
  }

  // =====================
  // EXTRACT SHORTCODE from URL or DOM
  // =====================
  function getShortcodeFromUrl() {
    const m = window.location.pathname.match(/\/(reel|reels|p)\/([A-Za-z0-9_-]+)/);
    return m ? m[2] : null;
  }

  function getShortcodeFromVideo(videoEl) {
    // Walk up the DOM to find a permalink link near this video
    let container = videoEl?.closest("article") || videoEl?.closest("[role='dialog']") || videoEl?.parentElement;
    for (let i = 0; i < 15 && container; i++) {
      const links = container.querySelectorAll('a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"]');
      for (const link of links) {
        const m = link.getAttribute("href")?.match(/\/(reel|reels|p)\/([A-Za-z0-9_-]+)/);
        if (m) return m[2];
      }
      container = container.parentElement;
    }
    return null;
  }

  // =====================
  // EXTRACT VIDEO/AUDIO URLs (delegates to background which runs in MAIN world)
  // =====================
  function extractMediaUrls(videoIndex, videoEl) {
    return new Promise((resolve) => {
      const msg = { action: "extractVideoUrl" };
      if (videoIndex !== undefined) msg.videoIndex = videoIndex;

      // Pass shortcode from URL or DOM for API fallback
      const shortcode = getShortcodeFromUrl() || getShortcodeFromVideo(videoEl);
      if (shortcode) msg.shortcode = shortcode;

      safeSendMessage(msg, (res) => {
        if (res?.success) {
          resolve({ videoUrl: res.videoUrl, audioUrl: res.audioUrl });
        } else {
          resolve(null);
        }
      });
    });
  }

  // =====================
  // FLOATING BUTTON
  // =====================
  function createButton() {
    if (buttonContainer) return;

    buttonContainer = document.createElement("div");
    buttonContainer.className = "ig-toolkit-btn hidden";
    buttonContainer.innerHTML = `
      <button class="ig-toolkit-main-btn" id="ig-toolkit-toggle">
        <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
        Download
      </button>
      <div class="ig-toolkit-dropdown" id="ig-toolkit-dropdown">
        <button class="ig-toolkit-dropdown-item" data-action="video">
          <svg viewBox="0 0 24 24"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>
          Download Vídeo
        </button>
        <button class="ig-toolkit-dropdown-item" data-action="audio">
          <svg viewBox="0 0 24 24"><path d="M12 3v9.28c-.47-.17-.97-.28-1.5-.28C8.01 12 6 14.01 6 16.5S8.01 21 10.5 21c2.31 0 4.2-1.75 4.45-4H15V6h4V3h-7z"/></svg>
          Extrair Áudio
        </button>
      </div>
    `;
    document.body.appendChild(buttonContainer);

    buttonContainer.querySelector("#ig-toolkit-toggle").addEventListener("click", () => {
      buttonContainer.querySelector("#ig-toolkit-dropdown").classList.toggle("open");
    });

    document.addEventListener("click", (e) => {
      if (buttonContainer && !buttonContainer.contains(e.target)) {
        buttonContainer.querySelector("#ig-toolkit-dropdown").classList.remove("open");
      }
    });

    buttonContainer.querySelector("#ig-toolkit-dropdown").addEventListener("click", async (e) => {
      const item = e.target.closest("[data-action]");
      if (!item || isDownloading) return;
      buttonContainer.querySelector("#ig-toolkit-dropdown").classList.remove("open");

      isDownloading = true;
      try {
        showToast("Buscando mídia...");
        // When popup is open, find the video INSIDE the dialog, not the first video on page
        const dialog = document.querySelector("[role='dialog']");
        const firstVideo = dialog ? dialog.querySelector("video") : document.querySelector("video");
        const vidIdx = firstVideo ? getVideoIndex(firstVideo) : undefined;
        const media = await extractMediaUrls(vidIdx, firstVideo);

        if (!media) {
          showToast("Não foi possível encontrar URLs de mídia");
          return;
        }

        if (item.dataset.action === "video") {
          if (!media.videoUrl) { showToast("URL de vídeo não encontrada"); return; }
          await downloadVideo(media.videoUrl);
        } else {
          // For audio: use audioUrl directly (DASH gives separate audio track!)
          if (media.audioUrl) {
            await downloadAudioFile(media.audioUrl);
          } else if (media.videoUrl) {
            // Fallback: extract audio from video
            await extractAudio(media.videoUrl);
          } else {
            showToast("URL de áudio não encontrada");
          }
        }
      } catch (err) {
        console.error(err);
        showToast("Erro: " + err.message);
      } finally {
        isDownloading = false;
      }
    });
  }

  // =====================
  // DOWNLOAD VIDEO
  // =====================
  function downloadVideo(videoUrl) {
    return new Promise((resolve) => {
      showToast("Baixando vídeo...");
      safeSendMessage(
        { action: "downloadFile", url: videoUrl, filename: `instagram_${Date.now()}.mp4` },
        (res) => {
          showToast(res?.success ? "Vídeo salvo!" : "Erro ao baixar vídeo");
          resolve();
        }
      );
    });
  }

  // =====================
  // DOWNLOAD AUDIO (fetch DASH audio, decode, save as WAV)
  // =====================
  function downloadAudioFile(url) {
    return new Promise((resolve) => {
      showToast("Convertendo áudio...");
      safeSendMessage({ action: "fetchVideoData", url }, async (res) => {
        if (!res?.success) { showToast("Erro ao buscar áudio"); resolve(); return; }

        try {
          const bytes = Uint8Array.from(atob(res.base64), c => c.charCodeAt(0));
          const ctx = new OfflineAudioContext(2, 44100 * 120, 44100);
          const audioBuf = await ctx.decodeAudioData(bytes.buffer);
          const wavBlob = audioBufferToWav(audioBuf);

          const reader = new FileReader();
          reader.onloadend = () => {
            safeSendMessage(
              { action: "downloadAudio", dataUrl: reader.result, filename: `instagram_${Date.now()}.wav` },
              (r) => { showToast(r?.success ? "Áudio salvo!" : "Erro ao salvar"); resolve(); }
            );
          };
          reader.readAsDataURL(wavBlob);
        } catch (err) {
          console.error("Audio decode error:", err);
          showToast("Erro ao converter áudio");
          resolve();
        }
      });
    });
  }

  // =====================
  // EXTRACT AUDIO
  // =====================
  function extractAudio(url) {
    return new Promise((resolve) => {
      showToast("Extraindo áudio...");
      safeSendMessage({ action: "fetchVideoData", url }, async (res) => {
        if (!res?.success) { showToast("Erro ao buscar vídeo"); resolve(); return; }

        try {
          const bytes = Uint8Array.from(atob(res.base64), c => c.charCodeAt(0));
          const ctx = new OfflineAudioContext(2, 44100 * 120, 44100);
          const audioBuf = await ctx.decodeAudioData(bytes.buffer);
          const wavBlob = audioBufferToWav(audioBuf);

          const reader = new FileReader();
          reader.onloadend = () => {
            safeSendMessage(
              { action: "downloadAudio", dataUrl: reader.result, filename: `instagram_${Date.now()}.wav` },
              (r) => { showToast(r?.success ? "Áudio salvo!" : "Erro ao salvar"); resolve(); }
            );
          };
          reader.readAsDataURL(wavBlob);
        } catch (err) {
          console.error("Audio error:", err);
          showToast("Erro ao extrair áudio");
          resolve();
        }
      });
    });
  }

  function audioBufferToWav(buf) {
    const ch = buf.numberOfChannels, sr = buf.sampleRate;
    const blockAlign = ch * 2, dataSize = buf.length * blockAlign;
    const ab = new ArrayBuffer(44 + dataSize), v = new DataView(ab);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, "RIFF"); v.setUint32(4, 36 + dataSize, true); w(8, "WAVE");
    w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, ch, true); v.setUint32(24, sr, true);
    v.setUint32(28, sr * blockAlign, true); v.setUint16(32, blockAlign, true);
    v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, dataSize, true);
    const channels = [];
    for (let c = 0; c < ch; c++) channels.push(buf.getChannelData(c));
    let off = 44;
    for (let i = 0; i < buf.length; i++) {
      for (let c = 0; c < ch; c++) {
        let s = Math.max(-1, Math.min(1, channels[c][i]));
        v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        off += 2;
      }
    }
    return new Blob([ab], { type: "audio/wav" });
  }

  // =====================
  // INLINE BUTTONS (on each video in the feed)
  // =====================
  function getVideoIndex(videoEl) {
    const all = document.querySelectorAll("video");
    for (let i = 0; i < all.length; i++) {
      if (all[i] === videoEl) return i;
    }
    return 0;
  }

  function createInlineButton(videoEl) {
    // Find a positioned parent to attach the button to
    let container = videoEl.closest("article") || videoEl.parentElement;
    if (!container) return;

    // Make container relative if needed
    const cs = window.getComputedStyle(container);
    if (cs.position === "static") container.style.position = "relative";

    const btn = document.createElement("div");
    btn.className = "ig-toolkit-inline-btn";
    btn.innerHTML = `
      <button class="ig-toolkit-inline-main" title="Download">
        <svg viewBox="0 0 24 24" width="20" height="20"><path fill="white" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
      </button>
      <div class="ig-toolkit-inline-dropdown">
        <button class="ig-toolkit-dropdown-item" data-action="video">
          <svg viewBox="0 0 24 24"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>
          Vídeo
        </button>
        <button class="ig-toolkit-dropdown-item" data-action="audio">
          <svg viewBox="0 0 24 24"><path d="M12 3v9.28c-.47-.17-.97-.28-1.5-.28C8.01 12 6 14.01 6 16.5S8.01 21 10.5 21c2.31 0 4.2-1.75 4.45-4H15V6h4V3h-7z"/></svg>
          Áudio
        </button>
      </div>
    `;
    container.appendChild(btn);

    const mainBtn = btn.querySelector(".ig-toolkit-inline-main");
    const dropdown = btn.querySelector(".ig-toolkit-inline-dropdown");

    mainBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      // Close all other dropdowns
      document.querySelectorAll(".ig-toolkit-inline-dropdown.open").forEach(d => {
        if (d !== dropdown) d.classList.remove("open");
      });
      dropdown.classList.toggle("open");
    });

    dropdown.addEventListener("click", async (e) => {
      e.stopPropagation();
      e.preventDefault();
      const item = e.target.closest("[data-action]");
      if (!item || isDownloading) return;
      dropdown.classList.remove("open");

      isDownloading = true;
      try {
        showToast("Buscando mídia...");
        const vidIdx = getVideoIndex(videoEl);
        const media = await extractMediaUrls(vidIdx, videoEl);

        if (!media) {
          showToast("Não foi possível encontrar URLs de mídia");
          return;
        }

        if (item.dataset.action === "video") {
          if (!media.videoUrl) { showToast("URL de vídeo não encontrada"); return; }
          await downloadVideo(media.videoUrl);
        } else {
          if (media.audioUrl) {
            await downloadAudioFile(media.audioUrl);
          } else if (media.videoUrl) {
            await extractAudio(media.videoUrl);
          } else {
            showToast("URL de áudio não encontrada");
          }
        }
      } catch (err) {
        console.error(err);
        showToast("Erro: " + err.message);
      } finally {
        isDownloading = false;
      }
    });

    // Mark video as processed
    videoEl.dataset.igToolkit = "true";
  }

  function scanForVideos() {
    if (!chrome.runtime?.id) return;

    const videos = document.querySelectorAll("video");
    videos.forEach((video) => {
      if (video.dataset.igToolkit) return; // already has button
      createInlineButton(video);
    });
  }

  // =====================
  // PAGE MONITOR
  // =====================
  function checkPage() {
    if (!chrome.runtime?.id) return;

    const path = window.location.pathname;
    const isVideoPage = /\/(reel|reels|p)\//i.test(path);
    const hasVideo = document.querySelector("video") !== null;

    // Floating button for dedicated pages
    if (isVideoPage && hasVideo) {
      createButton();
      buttonContainer.classList.remove("hidden");
    } else if (buttonContainer) {
      buttonContainer.classList.add("hidden");
    }

    // Inline buttons on all videos (feed, explore, etc.)
    scanForVideos();
  }

  // Close dropdowns when clicking outside
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".ig-toolkit-inline-btn")) {
      document.querySelectorAll(".ig-toolkit-inline-dropdown.open").forEach(d => d.classList.remove("open"));
    }
  });

  intervalId = setInterval(checkPage, 1500);
  checkPage();

  // =====================
  // TOAST
  // =====================
  function showToast(text) {
    document.querySelectorAll(".ig-toolkit-toast").forEach(t => t.remove());
    const t = document.createElement("div");
    t.className = "ig-toolkit-toast";
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 300); }, 2500);
  }
})();
