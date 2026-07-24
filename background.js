// =====================
// CONTEXT MENU (image copy)
// =====================
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "copy-instagram-image",
    title: "Copiar imagem do Instagram",
    contexts: ["all"],
    documentUrlPatterns: ["https://www.instagram.com/*"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "copy-instagram-image") return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
  } catch (e) {}

  setTimeout(() => {
    chrome.tabs.sendMessage(tab.id, { action: "copyImage" });
  }, 100);
});

// =====================
// EXTRACT VIDEO URL (runs in page's MAIN world, can access React internals)
// Instagram uses DASH streaming (MPD manifest), so we need to parse BaseURLs from the MPD
// Returns: { videoUrl, audioUrl } or null
// =====================
function extractVideoFromPage() {
  // Shortcode of the reel the user actually asked for (set by the background
  // script before injection). When present, we refuse any media data that
  // can't be proven to belong to this reel — profile pages keep many reels
  // in React state and a blind search can grab URLs from an unrelated one.
  var targetShortcode = (typeof window.__igToolkitTargetShortcode === "string" && window.__igToolkitTargetShortcode) || null;

  // "Do we already have the video we're allowed to use?"
  // With a target: only a VERIFIED match counts. Without: any video_versions.
  function haveTargetVideo(result) {
    return targetShortcode ? !!result.verifiedVideo : !!result.hasVideoVersions;
  }

  // Parse DASH MPD manifest XML and extract BaseURLs
  function parseMpd(mpdString) {
    try {
      var parser = new DOMParser();
      var xml = parser.parseFromString(mpdString, "text/xml");
      var adaptationSets = xml.querySelectorAll("AdaptationSet");
      var result = {};

      for (var i = 0; i < adaptationSets.length; i++) {
        var as = adaptationSets[i];
        var contentType = as.getAttribute("contentType");
        var mimeType = as.getAttribute("mimeType") || "";
        var baseUrlEl = as.querySelector("Representation BaseURL") || as.querySelector("BaseURL");

        if (baseUrlEl && baseUrlEl.textContent) {
          var url = baseUrlEl.textContent.trim();
          // Fix HTML-encoded ampersands
          url = url.replace(/&amp;/g, "&");

          if (contentType === "video" || mimeType.includes("video")) {
            result.videoUrl = url;
          } else if (contentType === "audio" || mimeType.includes("audio")) {
            result.audioUrl = url;
          }
        }
      }

      // If no contentType attribute, try by codec
      if (!result.videoUrl || !result.audioUrl) {
        var representations = xml.querySelectorAll("Representation");
        for (var i = 0; i < representations.length; i++) {
          var rep = representations[i];
          var codecs = rep.getAttribute("codecs") || "";
          var mime = rep.getAttribute("mimeType") || "";
          var baseUrl = rep.querySelector("BaseURL");
          if (!baseUrl) continue;
          var url = baseUrl.textContent.trim().replace(/&amp;/g, "&");

          if (!result.videoUrl && (codecs.startsWith("avc") || mime.includes("video"))) {
            result.videoUrl = url;
          } else if (!result.audioUrl && (codecs.startsWith("mp4a") || mime.includes("audio"))) {
            result.audioUrl = url;
          }
        }
      }

      if (result.videoUrl || result.audioUrl) return result;
    } catch(e) {
      console.log("MPD parse error:", e);
    }
    return null;
  }

  // Deep search React data for video_versions (MP4 with audio) AND dash manifest.
  // `inTarget` = we are inside the subtree of the media object whose shortcode
  // matches the reel the user asked for, so its data is trusted.
  function deepSearch(obj, depth, visited, result, inTarget) {
    if (depth > 12 || !obj || typeof obj !== "object") return;
    if (visited.has(obj)) return;
    visited.add(obj);

    try {
      // Media objects carry their own shortcode in `code`/`shortcode`
      var ownCode = null;
      if (typeof obj.code === "string" && /^[A-Za-z0-9_-]{5,}$/.test(obj.code)) {
        ownCode = obj.code;
      } else if (typeof obj.shortcode === "string" && /^[A-Za-z0-9_-]{5,}$/.test(obj.shortcode)) {
        ownCode = obj.shortcode;
      }

      // Prune subtrees that provably belong to a DIFFERENT reel
      if (targetShortcode && ownCode && ownCode !== targetShortcode) return;

      var isTarget = inTarget || (targetShortcode && ownCode === targetShortcode);
      // With a known target, only harvest data proven to belong to it;
      // without a target, keep the old permissive behavior.
      var canHarvest = !targetShortcode || isTarget;

      // Check for video_versions (complete MP4 with audio - PRIORITY)
      var versions = obj.video_versions || obj.videoVersions;
      if (canHarvest && Array.isArray(versions) && versions.length > 0 && versions[0].url) {
        // video_versions always takes priority over DASH video
        if (!result.videoUrl || result.isDash) {
          result.videoUrl = versions[0].url;
          result.isDash = false;
          result.hasVideoVersions = true;
          if (isTarget) result.verifiedVideo = true;
        }
      }

      if (canHarvest) {
        // Grab media id/pk and shortcode for API fallback
        // pk must be purely numeric (string or number)
        if (!result.mediaId && obj.pk) {
          var pkStr = String(obj.pk);
          if (/^\d+$/.test(pkStr)) result.mediaId = pkStr;
        }
        if (!result.mediaId && obj.id && typeof obj.id === "string") {
          var idPart = obj.id.split("_")[0];
          if (/^\d+$/.test(idPart)) result.mediaId = idPart;
        }
        if (!result.shortcode && ownCode) result.shortcode = ownCode;
      }

      // Check for dash manifest (for isolated audio track)
      var mpdFields = ["video_dash_manifest", "videoDashManifest", "dash_manifest", "dashManifest"];
      for (var f = 0; f < mpdFields.length; f++) {
        if (canHarvest && typeof obj[mpdFields[f]] === "string" && obj[mpdFields[f]].includes("<MPD")) {
          var parsed = parseMpd(obj[mpdFields[f]]);
          if (parsed) {
            if (parsed.audioUrl && !result.audioUrl) {
              result.audioUrl = parsed.audioUrl;
              if (isTarget) result.verifiedAudio = true;
            }
            if (!result.dashVideoUrl && parsed.videoUrl) result.dashVideoUrl = parsed.videoUrl;
          }
        }
      }

      // Recurse into properties
      var keys = Object.keys(obj);
      for (var i = 0; i < keys.length; i++) {
        var val = obj[keys[i]];
        if (canHarvest && typeof val === "string" && val.includes("<MPD")) {
          var parsed = parseMpd(val);
          if (parsed) {
            if (parsed.audioUrl && !result.audioUrl) {
              result.audioUrl = parsed.audioUrl;
              if (isTarget) result.verifiedAudio = true;
            }
            if (!result.dashVideoUrl && parsed.videoUrl) result.dashVideoUrl = parsed.videoUrl;
          }
        }
        if (typeof val === "object" && val !== null) {
          deepSearch(val, depth + 1, visited, result, isTarget);
        }
      }
    } catch(e) {}
  }

  // Walk a React fiber tree upwards from a DOM element, collecting media URLs
  function walkFiberTree(element, result, visited) {
    var fiberKey = Object.keys(element).find(function(k) {
      return k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$");
    });
    if (!fiberKey) return;

    var node = element[fiberKey];
    if (!visited) visited = new Set();

    for (var j = 0; j < 50 && node; j++) {
      if (node.memoizedProps) {
        deepSearch(node.memoizedProps, 0, visited, result);
      }
      if (node.pendingProps && node.pendingProps !== node.memoizedProps) {
        deepSearch(node.pendingProps, 0, visited, result);
      }
      if (node.memoizedState) {
        var state = node.memoizedState;
        for (var h = 0; h < 30 && state; h++) {
          if (state.memoizedState) {
            deepSearch(state.memoizedState, 0, visited, result);
          }
          state = state.next;
        }
      }
      // Stop early if we have a usable video
      if (haveTargetVideo(result)) break;
      node = node.return;
    }
  }

  // Walk DOWN a fiber tree (child/sibling) to find video data
  function walkFiberDown(node, result, visited, depth) {
    if (!node || depth > 15) return;
    if (haveTargetVideo(result)) return;

    if (node.memoizedProps) {
      deepSearch(node.memoizedProps, 0, visited, result);
    }
    if (node.memoizedState) {
      var state = node.memoizedState;
      for (var h = 0; h < 15 && state; h++) {
        if (state.memoizedState) {
          deepSearch(state.memoizedState, 0, visited, result);
        }
        state = state.next;
      }
    }

    // Recurse into children and siblings
    if (node.child) walkFiberDown(node.child, result, visited, depth + 1);
    if (node.sibling) walkFiberDown(node.sibling, result, visited, depth + 1);
  }

  // Walk React fiber tree from video elements, collecting all media URLs
  var result = {};

  try {
    var videos;
    var startIdx, endIdx;

    // If a dialog is open, ONLY search videos inside the dialog
    var activeDialog = document.querySelector("[role='dialog']");
    if (activeDialog && activeDialog.querySelector("video")) {
      videos = activeDialog.querySelectorAll("video");
      console.log("Dialog open with video, searching only dialog videos:", videos.length);
      startIdx = 0;
      endIdx = videos.length;
    } else {
      videos = document.querySelectorAll("video");
      // If videoIndex is passed (via window.__igToolkitVideoIndex), only check that video
      startIdx = typeof window.__igToolkitVideoIndex === "number" ? window.__igToolkitVideoIndex : 0;
      endIdx = typeof window.__igToolkitVideoIndex === "number" ? window.__igToolkitVideoIndex + 1 : videos.length;
    }

    for (var i = startIdx; i < endIdx && i < videos.length; i++) {
      walkFiberTree(videos[i], result);
      if (result.videoUrl || result.audioUrl) break;
    }

    // If we don't have a usable video yet, try broader searches:
    var needsBroaderSearch = !haveTargetVideo(result);

    // 1. Search from dialog/modal container (popup overlay) — walk UP and DOWN
    if (needsBroaderSearch) {
      var dialogs = document.querySelectorAll("[role='dialog']");
      for (var d = 0; d < dialogs.length && !haveTargetVideo(result); d++) {
        console.log("Searching dialog fiber tree (up)...");
        walkFiberTree(dialogs[d], result);

        // Also walk DOWN from dialog's fiber root to find video data
        if (!haveTargetVideo(result)) {
          var dialogFiberKey = Object.keys(dialogs[d]).find(function(k) {
            return k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$");
          });
          if (dialogFiberKey) {
            console.log("Searching dialog fiber tree (down)...");
            var dialogVisited = new Set();
            walkFiberDown(dialogs[d][dialogFiberKey], result, dialogVisited, 0);
          }
        }
      }
    }

    // 2. Search from article elements containing videos
    if (!haveTargetVideo(result)) {
      for (var i = startIdx; i < endIdx && i < videos.length; i++) {
        var article = videos[i].closest("article");
        if (article) {
          console.log("Searching article fiber tree...");
          walkFiberTree(article, result);
          if (haveTargetVideo(result)) break;
        }
      }
    }

    // 3. Walk up ALL parent elements of the video (they may have __reactProps with video data)
    if (!haveTargetVideo(result)) {
      for (var i = startIdx; i < endIdx && i < videos.length; i++) {
        var parent = videos[i].parentElement;
        for (var p = 0; p < 20 && parent && !haveTargetVideo(result); p++) {
          // Check __reactProps$xxx on parent elements
          var propsKey = Object.keys(parent).find(function(k) {
            return k.startsWith("__reactProps$");
          });
          if (propsKey && parent[propsKey]) {
            deepSearch(parent[propsKey], 0, new Set(), result);
          }
          walkFiberTree(parent, result);
          parent = parent.parentElement;
        }
        if (haveTargetVideo(result)) break;
      }
    }

    // 4. Search from the overlay layers Instagram creates for popups
    if (!haveTargetVideo(result)) {
      var layers = document.querySelectorAll("[class*='overlay'], [class*='modal'], [class*='layer'], [class*='Dialog']");
      for (var l = 0; l < layers.length && !haveTargetVideo(result); l++) {
        console.log("Searching overlay/layer fiber tree...");
        walkFiberTree(layers[l], result);
      }
    }

    // 5. Last resort: search from React root
    if (!haveTargetVideo(result)) {
      var root = document.getElementById("react-root") || document.getElementById("mount_0_0_") || document.querySelector("#react-root");
      if (root) {
        console.log("Searching React root fiber tree...");
        walkFiberTree(root, result);
      }
    }
  } catch(e) {
    console.log("React fiber error:", e);
  }

  // Final fallback: use DASH video (mark it so we know it's audio-less)
  if (!result.videoUrl && result.dashVideoUrl) {
    result.videoUrl = result.dashVideoUrl;
    result.isDash = true;
  }

  console.log("extractVideoFromPage result:", JSON.stringify({
    targetShortcode: targetShortcode,
    hasVideoVersions: !!result.hasVideoVersions,
    verifiedVideo: !!result.verifiedVideo,
    verifiedAudio: !!result.verifiedAudio,
    isDash: !!result.isDash,
    hasVideoUrl: !!result.videoUrl,
    hasAudioUrl: !!result.audioUrl,
    mediaId: result.mediaId,
    shortcode: result.shortcode
  }));

  if (result.videoUrl || result.audioUrl) return result;
  return null;
}

// Fetch complete MP4 by loading the reel page HTML and extracting video_versions
// (runs in MAIN world with page cookies)
async function fetchCompleteVideoFromApi(mediaId, shortcode) {
  if (!shortcode) return null;

  // Strategy 1: Fetch the reel page HTML and parse embedded video data
  var paths = ["/reel/" + shortcode + "/", "/p/" + shortcode + "/"];

  for (var p = 0; p < paths.length; p++) {
    try {
      console.log("Fetching page:", paths[p]);
      var res = await fetch("https://www.instagram.com" + paths[p], {
        credentials: "include",
        headers: {
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "same-origin"
        }
      });
      if (!res.ok) {
        console.log("Page fetch", paths[p], "status:", res.status);
        continue;
      }
      var html = await res.text();
      console.log("Got HTML, length:", html.length);

      // Look for video_versions in the HTML (embedded JSON data)
      // Instagram embeds media data in script tags like: "video_versions":[{"width":...,"url":"..."}]
      var vvMatch = html.match(/"video_versions"\s*:\s*\[(\{[^[\]]*\}(?:,\{[^[\]]*\})*)\]/);
      if (vvMatch) {
        try {
          var versions = JSON.parse("[" + vvMatch[1] + "]");
          if (versions.length > 0 && versions[0].url) {
            var url = versions[0].url.replace(/\\u0026/g, "&").replace(/\\\//g, "/").replace(/\\/g, "");
            console.log("Found video_versions from page HTML!");
            return url;
          }
        } catch(e) {
          console.log("Failed to parse video_versions from HTML:", e);
        }
      }

      // Try broader regex for video_url
      var vuMatch = html.match(/"video_url"\s*:\s*"(https?:[^"]+)"/);
      if (vuMatch) {
        var url = vuMatch[1].replace(/\\u0026/g, "&").replace(/\\\//g, "/").replace(/\\/g, "");
        console.log("Found video_url from page HTML!");
        return url;
      }

    } catch(e) {
      console.log("Page fetch failed:", paths[p], e);
    }
  }

  // Strategy 2: Try API endpoint with converted numeric ID
  if (shortcode) {
    try {
      var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      var numId = BigInt(0);
      for (var i = 0; i < shortcode.length; i++) {
        numId = numId * BigInt(64) + BigInt(alphabet.indexOf(shortcode[i]));
      }
      var numericId = numId.toString();
      console.log("Trying API with numeric ID:", numericId);

      var csrfToken = "";
      try {
        var m = document.cookie.match(/csrftoken=([^;]+)/);
        if (m) csrfToken = m[1];
      } catch(e) {}

      var headers = { "X-Requested-With": "XMLHttpRequest", "Accept": "*/*" };
      if (csrfToken) headers["X-CSRFToken"] = csrfToken;

      var res = await fetch("https://www.instagram.com/api/v1/media/" + numericId + "/info/", {
        credentials: "include",
        headers: headers
      });
      console.log("API v1 status:", res.status);
      if (res.ok) {
        var data = await res.json();
        var item = data.items ? data.items[0] : data;
        if (item && item.video_versions && item.video_versions.length > 0) {
          console.log("Found video_versions via API v1!");
          return item.video_versions[0].url;
        }
        if (item && item.video_url) return item.video_url;
      }
    } catch(e) {
      console.log("API v1 failed:", e);
    }
  }

  return null;
}

// Clean Instagram CDN URLs (unescape unicode, fix encoding)
function cleanUrl(url) {
  if (!url || typeof url !== "string") return null;

  // Unescape unicode sequences like \u0026 -> &
  url = url.replace(/\\u([0-9a-fA-F]{4})/g, (_, code) =>
    String.fromCharCode(parseInt(code, 16))
  );
  // Remove backslash escapes from JSON (e.g., \/ -> /)
  url = url.replace(/\\\//g, "/");
  // Remove any remaining backslashes
  url = url.replace(/\\/g, "");
  // Trim whitespace
  url = url.trim();

  // Validate it's a proper URL
  try {
    new URL(url);
    return url;
  } catch {
    console.error("Invalid URL after cleaning:", url);
    return null;
  }
}

// =====================
// OFFSCREEN DOCUMENT MANAGEMENT
// =====================
let offscreenCreating = null;

async function ensureOffscreenDocument() {
  // Check if already exists
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("offscreen.html")]
  });
  if (existingContexts.length > 0) return;

  // Avoid race condition
  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }

  offscreenCreating = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["WORKERS"],
    justification: "Run Whisper speech-to-text model in a Web Worker"
  });
  await offscreenCreating;
  offscreenCreating = null;
}

// =====================
// MESSAGE HANDLERS
// =====================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Extract video/audio URLs using MAIN world script injection
  if (message.action === "extractVideoUrl") {
    // Set the video index AND the target shortcode before running extraction.
    // The target shortcode lets the MAIN-world extractor reject media data
    // belonging to other reels kept in React state (profile grids etc.).
    const setContext = chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: "MAIN",
      func: (idx, sc) => {
        if (typeof idx === "number") window.__igToolkitVideoIndex = idx;
        else delete window.__igToolkitVideoIndex;
        if (sc) window.__igToolkitTargetShortcode = sc;
        else delete window.__igToolkitTargetShortcode;
      },
      args: [
        typeof message.videoIndex === "number" ? message.videoIndex : null,
        message.shortcode || null
      ]
    });

    const tabId = sender.tab.id;
    const shortcodeFromContent = message.shortcode;

    setContext.then(() => chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: extractVideoFromPage
    })).then(async (results) => {
      const data = results?.[0]?.result || {};
      console.log("React data:", JSON.stringify(data));

      // When a target shortcode was known, the extractor only returns URLs
      // proven to belong to that reel — so a missing URL here means
      // "not found", never "found the wrong reel".
      const audioUrl = cleanUrl(data.audioUrl);
      const shortcode = shortcodeFromContent || data.shortcode;
      const mediaId = data.mediaId;
      let videoUrl = cleanUrl(data.videoUrl);
      const hasVideoVersions = data.hasVideoVersions;

      // Fall back to fetching the reel page directly (correct by construction,
      // since it's fetched by shortcode) when fiber data didn't give us a
      // complete MP4 for the requested reel.
      if (!hasVideoVersions && (mediaId || shortcode)) {
        console.log("Fetching complete MP4 via page fetch. shortcode:", shortcode);
        try {
          const apiResults = await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: fetchCompleteVideoFromApi,
            args: [mediaId || null, shortcode || null]
          });
          const apiUrl = apiResults?.[0]?.result;
          console.log("API returned:", apiUrl);
          if (apiUrl) {
            const cleanedApiUrl = cleanUrl(apiUrl);
            if (cleanedApiUrl) videoUrl = cleanedApiUrl;
          }
        } catch(e) {
          console.log("API call failed:", e);
        }
      } else if (hasVideoVersions) {
        console.log("Found video_versions (complete MP4 with audio), skipping API");
      }

      console.log("Final Video URL:", videoUrl);
      console.log("Final Audio URL:", audioUrl);
      sendResponse({ success: !!(videoUrl || audioUrl), videoUrl, audioUrl });
    }).catch((err) => {
      console.error("Extract error:", err);
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // Fetch image from CDN (background has host_permissions)
  if (message.action === "fetchImage") {
    fetch(message.url)
      .then((res) => res.arrayBuffer())
      .then((buffer) => {
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        sendResponse({ success: true, dataUrl: "data:image/jpeg;base64," + btoa(binary) });
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // Download file directly from CDN URL
  if (message.action === "downloadFile") {
    console.log("Downloading:", message.url);
    chrome.downloads.download({
      url: message.url,
      filename: message.filename,
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error("Download error:", chrome.runtime.lastError.message);
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        console.log("Download started, id:", downloadId);
        sendResponse({ success: true });
      }
    });
    return true;
  }

  // Fetch video as base64 for audio extraction
  if (message.action === "fetchVideoData") {
    fetch(message.url)
      .then((res) => res.arrayBuffer())
      .then((buffer) => {
        const bytes = new Uint8Array(buffer);
        let binary = "";
        const chunkSize = 8192;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          const chunk = bytes.subarray(i, i + chunkSize);
          binary += String.fromCharCode.apply(null, chunk);
        }
        sendResponse({ success: true, base64: btoa(binary) });
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // Download audio WAV blob
  if (message.action === "downloadAudio") {
    chrome.downloads.download({
      url: message.dataUrl,
      filename: message.filename,
      saveAs: false
    }, () => sendResponse({ success: true }));
    return true;
  }

  // =====================
  // YOUTUBE: Get caption tracks via MAIN world injection
  // =====================
  if (message.action === "getYouTubeCaptionTracks") {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: "MAIN",
      func: () => {
        try {
          // Try ytInitialPlayerResponse first (set on page load)
          var pr = window.ytInitialPlayerResponse;
          if (!pr) {
            // Fallback: try to get from ytplayer config
            var cfg = window.ytplayer?.config?.args;
            if (cfg?.raw_player_response) pr = cfg.raw_player_response;
          }
          if (!pr) {
            // Fallback: try to find it in the movie_player element
            var player = document.getElementById("movie_player");
            if (player && player.getPlayerResponse) {
              pr = player.getPlayerResponse();
            }
          }
          if (pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks) {
            return pr.captions.playerCaptionsTracklistRenderer.captionTracks;
          }
          return null;
        } catch(e) {
          return null;
        }
      }
    }).then(results => {
      sendResponse({ success: true, tracks: results?.[0]?.result || null });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // =====================
  // YOUTUBE: Fetch caption content (JSON3 format)
  // =====================
  if (message.action === "fetchCaptions") {
    const url = message.url + (message.url.includes("fmt=") ? "" : "&fmt=json3");
    fetch(url)
      .then(res => {
        if (!res.ok) throw new Error("Caption fetch failed: " + res.status);
        return res.json();
      })
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // =====================
  // WHISPER: Transcribe audio via offscreen document
  // =====================
  if (message.action === "transcribeAudio") {
    const tabId = sender.tab?.id;
    ensureOffscreenDocument().then(() => {
      chrome.runtime.sendMessage({
        action: "offscreenTranscribe",
        audioUrl: message.audioUrl,
        language: message.language,
        tabId: tabId
      }, (res) => {
        sendResponse(res);
      });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // =====================
  // WHISPER: Forward progress from offscreen to content script tab
  // =====================
  if (message.action === "whisperProgress") {
    if (message.tabId) {
      chrome.tabs.sendMessage(message.tabId, {
        action: "whisperProgress",
        message: message.message,
        progress: message.progress
      });
    }
    return false;
  }
});
