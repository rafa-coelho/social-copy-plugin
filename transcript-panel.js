// =====================
// TRANSCRIPT PANEL — Shared UI component for YouTube & Instagram
// =====================
window.TranscriptPanel = (function() {
  let panel = null;
  let currentLines = [];
  let videoElement = null;
  let timeUpdateHandler = null;
  let onLanguageChange = null;

  function formatTimestamp(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
    return m + ":" + String(s).padStart(2, "0");
  }

  function create(options) {
    if (panel) destroy();

    const languages = options.languages || [];
    const selectedLang = options.selectedLang || "";

    panel = document.createElement("div");
    panel.className = "ig-toolkit-transcript-panel";

    let langSelector = "";
    if (languages.length > 1) {
      langSelector = '<select class="ig-toolkit-transcript-lang">' +
        languages.map(l =>
          '<option value="' + l.code + '"' + (l.code === selectedLang ? ' selected' : '') + '>' + l.name + '</option>'
        ).join("") +
        '</select>';
    }

    panel.innerHTML =
      '<div class="ig-toolkit-transcript-header">' +
        '<span class="ig-toolkit-transcript-title">Transcrição</span>' +
        '<div class="ig-toolkit-transcript-actions">' +
          langSelector +
          '<button class="ig-toolkit-transcript-action" data-action="copy" title="Copiar tudo">' +
            '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>' +
          '</button>' +
          '<button class="ig-toolkit-transcript-action" data-action="close" title="Fechar">' +
            '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>' +
          '</button>' +
        '</div>' +
      '</div>' +
      '<div class="ig-toolkit-transcript-search">' +
        '<input type="text" placeholder="Buscar na transcrição..." class="ig-toolkit-transcript-search-input">' +
      '</div>' +
      '<div class="ig-toolkit-transcript-body"></div>';

    document.body.appendChild(panel);

    // Force reflow then animate in
    panel.offsetHeight;
    panel.classList.add("open");

    // Event handlers
    panel.querySelector('[data-action="close"]').addEventListener("click", destroy);
    panel.querySelector('[data-action="copy"]').addEventListener("click", copyAll);

    const searchInput = panel.querySelector(".ig-toolkit-transcript-search-input");
    searchInput.addEventListener("input", () => filterLines(searchInput.value));

    const langSelect = panel.querySelector(".ig-toolkit-transcript-lang");
    if (langSelect) {
      langSelect.addEventListener("change", () => {
        if (onLanguageChange) onLanguageChange(langSelect.value);
      });
    }

    return panel;
  }

  function setLines(lines, video) {
    currentLines = lines;
    videoElement = video || null;
    renderLines(lines);
    attachVideoSync();
  }

  function renderLines(lines) {
    if (!panel) return;
    const body = panel.querySelector(".ig-toolkit-transcript-body");
    if (!body) return;

    body.innerHTML = "";

    if (!lines || lines.length === 0) {
      body.innerHTML = '<div class="ig-toolkit-transcript-empty">Nenhuma transcrição disponível</div>';
      return;
    }

    lines.forEach((line, idx) => {
      const el = document.createElement("div");
      el.className = "ig-toolkit-transcript-line";
      el.dataset.index = idx;
      el.dataset.startMs = line.startMs;
      el.innerHTML =
        '<span class="ig-toolkit-transcript-ts">' + formatTimestamp(line.startMs) + '</span>' +
        '<span class="ig-toolkit-transcript-text">' + escapeHtml(line.text) + '</span>';

      el.addEventListener("click", () => {
        if (videoElement) {
          videoElement.currentTime = line.startMs / 1000;
          videoElement.play();
        }
      });

      body.appendChild(el);
    });
  }

  function filterLines(query) {
    if (!panel) return;
    const q = query.toLowerCase().trim();
    const lineEls = panel.querySelectorAll(".ig-toolkit-transcript-line");
    lineEls.forEach((el, idx) => {
      if (!q || currentLines[idx].text.toLowerCase().includes(q)) {
        el.style.display = "";
      } else {
        el.style.display = "none";
      }
    });
  }

  function attachVideoSync() {
    detachVideoSync();
    if (!videoElement) return;

    timeUpdateHandler = () => {
      if (!panel) return;
      const currentMs = videoElement.currentTime * 1000;
      const lineEls = panel.querySelectorAll(".ig-toolkit-transcript-line");
      let activeIdx = -1;

      for (let i = currentLines.length - 1; i >= 0; i--) {
        if (currentMs >= currentLines[i].startMs) {
          activeIdx = i;
          break;
        }
      }

      lineEls.forEach((el, idx) => {
        if (idx === activeIdx) {
          el.classList.add("active");
        } else {
          el.classList.remove("active");
        }
      });
    };

    videoElement.addEventListener("timeupdate", timeUpdateHandler);
  }

  function detachVideoSync() {
    if (videoElement && timeUpdateHandler) {
      videoElement.removeEventListener("timeupdate", timeUpdateHandler);
    }
    timeUpdateHandler = null;
  }

  function copyAll() {
    if (!currentLines || currentLines.length === 0) return;
    const text = currentLines.map(l => "[" + formatTimestamp(l.startMs) + "] " + l.text).join("\n");
    navigator.clipboard.writeText(text).then(() => {
      const btn = panel.querySelector('[data-action="copy"]');
      if (btn) {
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="#4ade80" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
        setTimeout(() => {
          btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
        }, 2000);
      }
    });
  }

  function destroy() {
    detachVideoSync();
    if (panel) {
      panel.classList.remove("open");
      setTimeout(() => {
        if (panel) { panel.remove(); panel = null; }
      }, 300);
    }
    currentLines = [];
    videoElement = null;
    onLanguageChange = null;
  }

  function isOpen() {
    return !!panel;
  }

  function setOnLanguageChange(cb) {
    onLanguageChange = cb;
  }

  function showLoading(message) {
    if (!panel) return;
    const body = panel.querySelector(".ig-toolkit-transcript-body");
    if (body) {
      body.innerHTML =
        '<div class="ig-toolkit-transcript-loading">' +
          '<div class="ig-toolkit-transcript-spinner"></div>' +
          '<span>' + escapeHtml(message || "Carregando...") + '</span>' +
        '</div>';
    }
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  return {
    create: create,
    setLines: setLines,
    destroy: destroy,
    isOpen: isOpen,
    setOnLanguageChange: setOnLanguageChange,
    showLoading: showLoading,
    formatTimestamp: formatTimestamp
  };
})();
