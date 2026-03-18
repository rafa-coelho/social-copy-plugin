// =====================
// YOUTUBE CONTENT SCRIPT — Caption extraction & transcript UI
// =====================
(function() {
  let transcriptBtn = null;
  let currentVideoId = null;
  let captionTracks = null;
  let isLoading = false;

  // Safe wrapper for chrome.runtime messages
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
  // VIDEO ID EXTRACTION
  // =====================
  function getVideoId() {
    const params = new URLSearchParams(window.location.search);
    return params.get("v");
  }

  // =====================
  // CAPTION TRACK DISCOVERY
  // =====================
  function getCaptionTracks() {
    return new Promise((resolve) => {
      safeSendMessage({ action: "getYouTubeCaptionTracks" }, (res) => {
        if (res?.success && res.tracks) {
          resolve(res.tracks);
        } else {
          // Fallback: try to parse from page HTML
          resolve(tryParseCaptionsFromPage());
        }
      });
    });
  }

  function tryParseCaptionsFromPage() {
    try {
      const scripts = document.querySelectorAll("script");
      for (const script of scripts) {
        const text = script.textContent;
        if (!text.includes("captionTracks")) continue;
        const match = text.match(/"captionTracks"\s*:\s*(\[.*?\])\s*[,}]/);
        if (match) {
          return JSON.parse(match[1]);
        }
      }
    } catch (e) {}
    return null;
  }

  // =====================
  // CAPTION FETCHING & PARSING
  // =====================
  function fetchCaptions(baseUrl) {
    return new Promise((resolve) => {
      safeSendMessage({ action: "fetchCaptions", url: baseUrl }, (res) => {
        if (res?.success && res.data) {
          resolve(parseCaptionJson3(res.data));
        } else {
          resolve(null);
        }
      });
    });
  }

  function parseCaptionJson3(data) {
    if (!data.events) return null;
    const lines = [];

    for (const event of data.events) {
      if (!event.segs) continue;
      const text = event.segs.map(s => s.utf8 || "").join("").trim();
      if (!text || text === "\n") continue;

      lines.push({
        startMs: event.tStartMs || 0,
        durationMs: event.dDurationMs || 0,
        text: text
      });
    }

    return lines;
  }

  // =====================
  // UI: TRANSCRIPT BUTTON
  // =====================
  function createTranscriptButton() {
    if (transcriptBtn) transcriptBtn.remove();

    transcriptBtn = document.createElement("div");
    transcriptBtn.className = "yt-toolkit-transcript-btn";
    transcriptBtn.innerHTML =
      '<button class="yt-toolkit-btn-main" title="Transcrição">' +
        '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V6h16v12zM6 10h2v2H6v-2zm0 4h8v2H6v-2zm10 0h2v2h-2v-2zm-6-4h8v2h-8v-2z"/></svg>' +
        '<span>Transcrição</span>' +
      '</button>';

    // Insert below the video player
    const insertTarget = document.querySelector("#above-the-fold #title") ||
                         document.querySelector("#info-contents") ||
                         document.querySelector("#below");

    if (insertTarget) {
      insertTarget.parentElement.insertBefore(transcriptBtn, insertTarget);
    } else {
      // Fallback: fixed position
      transcriptBtn.classList.add("yt-toolkit-btn-fixed");
      document.body.appendChild(transcriptBtn);
    }

    transcriptBtn.querySelector(".yt-toolkit-btn-main").addEventListener("click", handleTranscriptClick);
  }

  async function handleTranscriptClick() {
    if (isLoading) return;

    // Toggle off if already open
    if (window.TranscriptPanel.isOpen()) {
      window.TranscriptPanel.destroy();
      return;
    }

    isLoading = true;

    try {
      // Get caption tracks if not cached for this video
      const videoId = getVideoId();
      if (videoId !== currentVideoId || !captionTracks) {
        captionTracks = await getCaptionTracks();
        currentVideoId = videoId;
      }

      if (!captionTracks || captionTracks.length === 0) {
        showToast("Nenhuma legenda disponível para este vídeo");
        return;
      }

      // Prepare language options
      const languages = captionTracks.map(t => ({
        code: t.languageCode,
        name: t.name?.simpleText || t.languageCode,
        baseUrl: t.baseUrl
      }));

      // Create panel
      window.TranscriptPanel.create({
        languages: languages,
        selectedLang: languages[0].code
      });

      window.TranscriptPanel.showLoading("Carregando transcrição...");

      // Fetch captions for the first language
      const lines = await fetchCaptions(captionTracks[0].baseUrl);
      const video = document.querySelector("video");

      if (lines && lines.length > 0) {
        window.TranscriptPanel.setLines(lines, video);
      } else {
        window.TranscriptPanel.setLines([], null);
      }

      // Handle language change
      window.TranscriptPanel.setOnLanguageChange(async (langCode) => {
        const track = captionTracks.find(t => t.languageCode === langCode);
        if (!track) return;
        window.TranscriptPanel.showLoading("Carregando transcrição...");
        const newLines = await fetchCaptions(track.baseUrl);
        const vid = document.querySelector("video");
        window.TranscriptPanel.setLines(newLines || [], vid);
      });

    } catch (err) {
      console.error("Transcript error:", err);
      showToast("Erro ao carregar transcrição");
    } finally {
      isLoading = false;
    }
  }

  // =====================
  // TOAST
  // =====================
  function showToast(text) {
    document.querySelectorAll(".yt-toolkit-toast").forEach(t => t.remove());
    const t = document.createElement("div");
    t.className = "yt-toolkit-toast";
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 300); }, 2500);
  }

  // =====================
  // PAGE MONITORING (YouTube is SPA)
  // =====================
  function checkPage() {
    if (!chrome.runtime?.id) return;

    const videoId = getVideoId();
    if (!videoId) {
      // Not on a watch page
      if (transcriptBtn) { transcriptBtn.remove(); transcriptBtn = null; }
      if (window.TranscriptPanel.isOpen()) window.TranscriptPanel.destroy();
      return;
    }

    // Video changed
    if (videoId !== currentVideoId) {
      captionTracks = null;
      if (window.TranscriptPanel.isOpen()) window.TranscriptPanel.destroy();
    }

    // Ensure button exists
    if (!transcriptBtn || !document.body.contains(transcriptBtn)) {
      createTranscriptButton();
    }
  }

  // Listen for YouTube SPA navigation
  document.addEventListener("yt-navigate-finish", () => {
    setTimeout(checkPage, 500);
  });

  // Also listen for pushState/popState (backup)
  window.addEventListener("popstate", () => setTimeout(checkPage, 500));

  // Polling fallback
  setInterval(checkPage, 2000);
  checkPage();
})();
