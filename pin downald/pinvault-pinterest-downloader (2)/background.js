// PinVault — Background Service Worker (Manifest V3)
// Resolves highest-quality Pinterest images, GIFs, and videos (MP4 & HLS)
// using multi-tier extraction modeled on yt-dlp's Pinterest extractor.

const TAB_VIDEO_CACHE = new Map(); // tabId -> Array<{ url, type, hash, ts }>
const PIN_MEDIA_CACHE = new Map(); // pinId -> { result, ts }
const CACHE_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// 1. Passive CDN Video Sniffer (Manifest V3 read-only webRequest)
// ---------------------------------------------------------------------------
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const url = details.url;
    if (!url || !url.includes('pinimg.com/videos/')) return;

    const isMp4 = /\.mp4(\?|$)/i.test(url);
    const isHls = /\.m3u8(\?|$)/i.test(url);
    if (!isMp4 && !isHls) return;

    // Extract 32-char hex content hash if present
    const hashMatch = url.match(/\/([a-f0-9]{16,40})(?:_[^/.]+)?\.(?:mp4|m3u8)/i);
    const hash = hashMatch ? hashMatch[1].toLowerCase() : null;

    let list = TAB_VIDEO_CACHE.get(details.tabId);
    if (!list) {
      list = [];
      TAB_VIDEO_CACHE.set(details.tabId, list);
    }

    // Deduplicate and keep newest 60 entries per tab
    const existingIdx = list.findIndex((item) => item.url === url);
    if (existingIdx !== -1) list.splice(existingIdx, 1);

    list.unshift({
      url,
      type: isMp4 ? 'mp4' : 'hls',
      hash,
      ts: Date.now(),
    });
    if (list.length > 60) list.length = 60;
  },
  { urls: ['*://*.pinimg.com/videos/*'] }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  TAB_VIDEO_CACHE.delete(tabId);
});

// ---------------------------------------------------------------------------
// 2. Settings & Stats Helpers
// ---------------------------------------------------------------------------
async function getSettings() {
  const data = await chrome.storage.local.get({
    useSubfolder: true,
    downloadCount: 0,
    lastFile: '',
  });
  return data;
}

async function recordDownload(filename) {
  const data = await getSettings();
  await chrome.storage.local.set({
    downloadCount: (data.downloadCount || 0) + 1,
    lastFile: filename,
  });
}

function sanitizeFilename(raw, fallback = 'pinterest_media') {
  if (!raw || typeof raw !== 'string') return fallback;
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return cleaned || fallback;
}

function buildFilename(pinId, title, ext, useSubfolder) {
  const safeTitle = sanitizeFilename(title, '');
  const idPart = pinId ? `pin_${pinId}` : `pin_${Date.now()}`;
  const base = safeTitle ? `${idPart}_${safeTitle}` : idPart;
  const cleanExt = ext.replace(/^\./, '').toLowerCase();
  return useSubfolder ? `Pinterest/${base}.${cleanExt}` : `${base}.${cleanExt}`;
}

function getPinterestOrigin(pageUrl) {
  try {
    const u = new URL(pageUrl);
    if (u.hostname.includes('pinterest.')) return u.origin;
  } catch (_) {}
  return 'https://www.pinterest.com';
}

// ---------------------------------------------------------------------------
// 3. HTTP Helpers (HEAD probe & JSON/HTML fetch)
// ---------------------------------------------------------------------------
async function probeUrl(url, expectedPrefix = null) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (!res.ok) return null;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (expectedPrefix && ct && !ct.startsWith(expectedPrefix) && !ct.includes('octet-stream')) {
      return null;
    }
    const len = parseInt(res.headers.get('content-length') || '0', 10) || 0;
    return { url: res.url || url, contentType: ct, contentLength: len };
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 4. Highest-Quality Image Resolver (CDN Size Ladder + Extension Fallback)
// ---------------------------------------------------------------------------
async function resolveBestImageUrl(rawUrl) {
  if (!rawUrl) return null;

  // Non-pinimg images: return directly
  if (!rawUrl.includes('pinimg.com')) {
    return { url: rawUrl, ext: guessImageExt(rawUrl) };
  }

  // Match https://i.pinimg.com/<size>/<shard>/<hash>.<ext>
  const match = rawUrl.match(/^(https?:\/\/i\.pinimg\.com\/)([^/]+)(\/.+)\.([a-zA-Z0-9]+)(?:\?.*)?$/);
  if (!match) {
    return { url: rawUrl, ext: guessImageExt(rawUrl) };
  }

  const [, hostPrefix, currentSize, pathWithoutExt, origExt] = match;
  const lowerOrigExt = origExt.toLowerCase();

  // If already /originals/, verify directly first
  const sizeLadder = ['originals', '1200x', '736x', '564x'];
  const extCandidates = Array.from(new Set([lowerOrigExt, 'jpg', 'png', 'webp', 'gif']));

  // Step 1: Try /originals/ across possible extensions (Pinterest thumbnails are often .jpg even when original is .png/.gif/.webp)
  for (const ext of extCandidates) {
    const candidate = `${hostPrefix}originals${pathWithoutExt}.${ext}`;
    const probe = await probeUrl(candidate, 'image/');
    if (probe) {
      return { url: probe.url, ext: extFromContentType(probe.contentType, ext) };
    }
  }

  // Step 2: Fall down the size ladder with the original extension
  for (const size of sizeLadder.slice(1)) {
    if (size === currentSize) break;
    const candidate = `${hostPrefix}${size}${pathWithoutExt}.${lowerOrigExt}`;
    const probe = await probeUrl(candidate, 'image/');
    if (probe) {
      return { url: probe.url, ext: extFromContentType(probe.contentType, lowerOrigExt) };
    }
  }

  return { url: rawUrl, ext: lowerOrigExt };
}

function guessImageExt(url) {
  const m = url.match(/\.([a-zA-Z0-9]{3,4})(?:\?|$)/);
  return m ? m[1].toLowerCase() : 'jpg';
}

function extFromContentType(ct, fallback) {
  if (!ct) return fallback;
  if (ct.includes('image/png')) return 'png';
  if (ct.includes('image/webp')) return 'webp';
  if (ct.includes('image/gif')) return 'gif';
  if (ct.includes('image/jpeg') || ct.includes('image/jpg')) return 'jpg';
  return fallback;
}

// ---------------------------------------------------------------------------
// 5. Video List Extraction & Scoring (yt-dlp style)
// ---------------------------------------------------------------------------
function collectVideoLists(obj, out = [], depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 14) return out;

  if (obj.video_list && typeof obj.video_list === 'object') {
    out.push(obj.video_list);
  }

  if (Array.isArray(obj)) {
    for (const item of obj) collectVideoLists(item, out, depth + 1);
  } else {
    for (const key of Object.keys(obj)) {
      if (key === 'video_list') continue;
      const val = obj[key];
      if (val && typeof val === 'object') {
        collectVideoLists(val, out, depth + 1);
      }
    }
  }
  return out;
}

function collectOrigImages(obj, out = [], depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 10) return out;
  if (obj.images && obj.images.orig && typeof obj.images.orig.url === 'string') {
    out.push(obj.images.orig.url);
  }
  if (Array.isArray(obj)) {
    for (const item of obj) collectOrigImages(item, out, depth + 1);
  } else {
    for (const key of Object.keys(obj)) {
      if (key === 'images') continue;
      const val = obj[key];
      if (val && typeof val === 'object') collectOrigImages(val, out, depth + 1);
    }
  }
  return out;
}

function rankVideoFormats(videoLists) {
  const mp4Candidates = [];
  const hlsCandidates = [];
  const seen = new Set();

  for (const vlist of videoLists) {
    for (const [formatKey, meta] of Object.entries(vlist)) {
      if (!meta || typeof meta !== 'object' || typeof meta.url !== 'string') continue;
      const url = meta.url.trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);

      const width = Number(meta.width) || 0;
      const height = Number(meta.height) || 0;
      const pixels = width * height;
      const entry = {
        formatKey,
        url,
        width,
        height,
        pixels,
        duration: Number(meta.duration) || 0,
      };

      if (/\.mp4(\?|$)/i.test(url)) {
        mp4Candidates.push(entry);
      } else if (/\.m3u8(\?|$)/i.test(url)) {
        hlsCandidates.push(entry);
      }
    }
  }

  // Sort highest resolution first; tie-break by key preference (V_1080P > V_720P > V_EXP7)
  const keyBonus = (k) => {
    const up = (k || '').toUpperCase();
    if (up.includes('1080')) return 4000;
    if (up.includes('720')) return 3000;
    if (up.includes('EXP7')) return 2500;
    if (up.includes('EXP')) return 1500;
    if (up.includes('HLSV4')) return 2000;
    if (up.includes('HLSV3_WEB')) return 1800;
    return 0;
  };

  mp4Candidates.sort((a, b) => (b.pixels - a.pixels) || (keyBonus(b.formatKey) - keyBonus(a.formatKey)));
  hlsCandidates.sort((a, b) => (b.pixels - a.pixels) || (keyBonus(b.formatKey) - keyBonus(a.formatKey)));

  return { mp4Candidates, hlsCandidates };
}

// Derive direct MP4 URLs from Pinterest HLS URLs (e.g. /mc/hls/ -> /mc/720p/)
function deriveMp4FromHls(hlsUrl) {
  const candidates = [];
  if (!hlsUrl || !hlsUrl.includes('pinimg.com/videos/')) return candidates;

  // Pattern 1: /videos/mc/hls/ab/cd/ef/<hash>.m3u8 -> /videos/mc/720p/ab/cd/ef/<hash>.mp4
  if (hlsUrl.includes('/hls/')) {
    candidates.push(hlsUrl.replace('/hls/', '/720p/').replace(/\.m3u8(\?.*)?$/i, '.mp4'));
    candidates.push(hlsUrl.replace('/iht/hls/', '/mc/720p/').replace(/\.m3u8(\?.*)?$/i, '.mp4'));
    candidates.push(hlsUrl.replace('/hls/', '/expMp4/').replace(/\.m3u8(\?.*)?$/i, '_t1.mp4'));
    candidates.push(hlsUrl.replace('/iht/hls/', '/mc/expMp4/').replace(/\.m3u8(\?.*)?$/i, '_t1.mp4'));
  }

  return Array.from(new Set(candidates)).filter((c) => c !== hlsUrl);
}

// ---------------------------------------------------------------------------
// 6. Tier 1 & Tier 2 Pin Metadata Fetchers
// ---------------------------------------------------------------------------
async function fetchPinResourceJson(pinId, origin) {
  const options = {
    id: pinId,
    field_set_key: 'unauth_react_main_pin',
  };
  const apiUrl = `${origin}/resource/PinResource/get/?source_url=${encodeURIComponent(
    `/pin/${pinId}/`
  )}&data=${encodeURIComponent(JSON.stringify({ options }))}`;

  try {
    const res = await fetch(apiUrl, {
      credentials: 'include',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'X-Pinterest-AppState': 'active',
        'X-Pinterest-PWS-Handler': 'www/pin/[id].js',
        Accept: 'application/json, text/javascript, */*; q=0.01',
      },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.resource_response?.data || null;
  } catch (_) {
    return null;
  }
}

async function fetchPinPageHtmlMedia(pinId, origin) {
  const mp4Urls = new Set();
  const hlsUrls = new Set();
  const videoLists = [];
  const origImages = [];
  let title = '';

  try {
    const res = await fetch(`${origin}/pin/${pinId}/`, {
      credentials: 'include',
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    if (!res.ok) return { videoLists, mp4Urls: [], hlsUrls: [], origImages, title };
    const html = await res.text();

    // Extract title from <title> or og:title
    const ogTitle = html.match(/property="og:title"\s+content="([^"]+)"/i);
    if (ogTitle) title = ogTitle[1];

    // Parse embedded JSON scripts (__PWS_DATA__, __PWS_INITIAL_PROPS__, ld+json, data-relay-response)
    const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = scriptRegex.exec(html)) !== null) {
      const body = m[1].trim();
      if (!body || (!body.startsWith('{') && !body.startsWith('['))) continue;
      if (!body.includes('pinimg.com') && !body.includes('video_list')) continue;
      try {
        const parsed = JSON.parse(body);
        collectVideoLists(parsed, videoLists);
        collectOrigImages(parsed, origImages);
      } catch (_) {}
    }

    // Regex fallback across full HTML (handles escaped \/ slashes too)
    const unescaped = html.replace(/\\\//g, '/').replace(/\\u002F/gi, '/');
    const mp4Matches = unescaped.match(/https:\/\/v[0-9]*\.pinimg\.com\/videos\/[^"'\s\\<>]+\.mp4/gi) || [];
    const hlsMatches = unescaped.match(/https:\/\/v[0-9]*\.pinimg\.com\/videos\/[^"'\s\\<>]+\.m3u8/gi) || [];
    for (const u of mp4Matches) mp4Urls.add(u);
    for (const u of hlsMatches) hlsUrls.add(u);
  } catch (_) {}

  return {
    videoLists,
    mp4Urls: Array.from(mp4Urls),
    hlsUrls: Array.from(hlsUrls),
    origImages,
    title,
  };
}

// ---------------------------------------------------------------------------
// 7. Full Pin Media Resolution Pipeline
// ---------------------------------------------------------------------------
async function resolvePinMedia(payload, tabId) {
  const { pinId, mediaType, imgUrl, videoUrl, pageUrl, title } = payload;
  const origin = getPinterestOrigin(pageUrl);

  // Check short-lived cache for this pinId
  if (pinId && PIN_MEDIA_CACHE.has(pinId)) {
    const cached = PIN_MEDIA_CACHE.get(pinId);
    if (Date.now() - cached.ts < CACHE_TTL_MS && (!mediaType || cached.result.kind === mediaType || mediaType === 'auto')) {
      return cached.result;
    }
  }

  let resolvedTitle = title || '';
  const allVideoLists = [];
  const extraMp4s = [];
  const extraHls = [];
  const origImages = [];

  // Direct non-blob video URL from DOM
  if (videoUrl && !videoUrl.startsWith('blob:')) {
    if (/\.mp4(\?|$)/i.test(videoUrl)) extraMp4s.push(videoUrl);
    else if (/\.m3u8(\?|$)/i.test(videoUrl)) extraHls.push(videoUrl);
  }

  // Tier 1: PinResource API (fast, clean JSON)
  if (pinId) {
    const pinData = await fetchPinResourceJson(pinId, origin);
    if (pinData) {
      if (!resolvedTitle) {
        resolvedTitle = pinData.title || pinData.grid_title || pinData.description || '';
      }
      collectVideoLists(pinData, allVideoLists);
      collectOrigImages(pinData, origImages);
    }
  }

  // Rank what we got from Tier 1
  let ranked = rankVideoFormats(allVideoLists);

  // Tier 2: Pin Page HTML fallback if we expect a video (or auto) and Tier 1 found none
  if (pinId && ranked.mp4Candidates.length === 0 && ranked.hlsCandidates.length === 0 && (mediaType === 'video' || mediaType === 'auto')) {
    const htmlData = await fetchPinPageHtmlMedia(pinId, origin);
    if (!resolvedTitle && htmlData.title) resolvedTitle = htmlData.title;
    allVideoLists.push(...htmlData.videoLists);
    extraMp4s.push(...htmlData.mp4Urls);
    extraHls.push(...htmlData.hlsUrls);
    origImages.push(...htmlData.origImages);
    ranked = rankVideoFormats(allVideoLists);
  }

  // Merge extra regex/DOM URLs into candidates
  const seenMp4 = new Set(ranked.mp4Candidates.map((c) => c.url));
  for (const u of extraMp4s) {
    if (!seenMp4.has(u)) {
      seenMp4.add(u);
      ranked.mp4Candidates.push({ formatKey: 'DIRECT', url: u, pixels: u.includes('1080') ? 2073600 : u.includes('720') ? 921600 : 1 });
    }
  }
  const seenHls = new Set(ranked.hlsCandidates.map((c) => c.url));
  for (const u of extraHls) {
    if (!seenHls.has(u)) {
      seenHls.add(u);
      ranked.hlsCandidates.push({ formatKey: 'HLS', url: u, pixels: 0 });
    }
  }

  // Tier 3: Passive webRequest sniffer fallback for videos currently loaded in this tab
  if (mediaType === 'video' && ranked.mp4Candidates.length === 0 && ranked.hlsCandidates.length === 0 && tabId >= 0) {
    const sniffed = TAB_VIDEO_CACHE.get(tabId) || [];
    // Try matching poster image hash first, otherwise most recent video in the tab (within 90s)
    const imgHashMatch = (imgUrl || '').match(/\/([a-f0-9]{16,40})\./i);
    const imgHash = imgHashMatch ? imgHashMatch[1].toLowerCase() : null;

    const recent = sniffed.filter((s) => Date.now() - s.ts < 90_000);
    const matched = imgHash ? recent.filter((s) => s.hash === imgHash) : [];
    const pool = matched.length > 0 ? matched : recent.slice(0, 4);

    for (const item of pool) {
      if (item.type === 'mp4' && !seenMp4.has(item.url)) {
        seenMp4.add(item.url);
        ranked.mp4Candidates.push({ formatKey: 'SNIFFED_MP4', url: item.url, pixels: 1 });
      } else if (item.type === 'hls' && !seenHls.has(item.url)) {
        seenHls.add(item.url);
        ranked.hlsCandidates.push({ formatKey: 'SNIFFED_HLS', url: item.url, pixels: 0 });
      }
    }
  }

  // Decide Video vs Image
  const hasVideo = ranked.mp4Candidates.length > 0 || ranked.hlsCandidates.length > 0;
  if (mediaType === 'video' || (mediaType === 'auto' && hasVideo)) {
    // 1. Try direct MP4 candidates (highest resolution first)
    for (const cand of ranked.mp4Candidates) {
      const probe = await probeUrl(cand.url, 'video/');
      if (probe) {
        const result = { kind: 'video', mode: 'direct', url: probe.url, ext: 'mp4', title: resolvedTitle, pinId };
        if (pinId) PIN_MEDIA_CACHE.set(pinId, { result, ts: Date.now() });
        return result;
      }
    }

    // 2. Probe sibling MP4 URLs derived from HLS URLs (avoids HLS muxing whenever CDN has an MP4)
    for (const hlsCand of ranked.hlsCandidates) {
      const derived = deriveMp4FromHls(hlsCand.url);
      for (const mp4Try of derived) {
        const probe = await probeUrl(mp4Try, 'video/');
        if (probe) {
          const result = { kind: 'video', mode: 'direct', url: probe.url, ext: 'mp4', title: resolvedTitle, pinId };
          if (pinId) PIN_MEDIA_CACHE.set(pinId, { result, ts: Date.now() });
          return result;
        }
      }
    }

    // 3. Fallback: HLS stream assembly (downloads highest-bitrate variant segments & merges)
    if (ranked.hlsCandidates.length > 0) {
      const result = {
        kind: 'video',
        mode: 'hls',
        url: ranked.hlsCandidates[0].url,
        ext: 'mp4',
        title: resolvedTitle,
        pinId,
      };
      if (pinId) PIN_MEDIA_CACHE.set(pinId, { result, ts: Date.now() });
      return result;
    }

    // If explicitly requested video but truly none found, fall through to image only if imgUrl exists
    if (mediaType === 'video' && !imgUrl && origImages.length === 0) {
      throw new Error('Could not locate a video stream for this pin.');
    }
  }

  // Image resolution (prefer API orig image, then DOM imgUrl through CDN size ladder)
  const bestImageCandidate = origImages[0] || imgUrl;
  if (!bestImageCandidate) {
    throw new Error('Could not locate an image or video URL for this pin.');
  }

  const resolvedImg = await resolveBestImageUrl(bestImageCandidate);
  const result = {
    kind: 'image',
    mode: 'direct',
    url: resolvedImg.url,
    ext: resolvedImg.ext || 'jpg',
    title: resolvedTitle,
    pinId,
  };
  if (pinId) PIN_MEDIA_CACHE.set(pinId, { result, ts: Date.now() });
  return result;
}

// ---------------------------------------------------------------------------
// 8. Built-in HLS (.m3u8) Highest-Quality Stream Assembler
// ---------------------------------------------------------------------------
function resolveRelativeUrl(baseUrl, rel) {
  try {
    return new URL(rel, baseUrl).href;
  } catch (_) {
    return rel;
  }
}

async function fetchHlsSegments(masterUrl) {
  const masterRes = await fetch(masterUrl);
  if (!masterRes.ok) throw new Error(`HLS playlist fetch failed (${masterRes.status})`);
  let playlistText = await masterRes.text();
  let playlistUrl = masterRes.url || masterUrl;

  // If this is a master playlist (#EXT-X-STREAM-INF), pick the highest bandwidth/resolution variant
  if (playlistText.includes('#EXT-X-STREAM-INF')) {
    const lines = playlistText.split(/\r?\n/);
    let bestVariant = null;
    let bestScore = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith('#EXT-X-STREAM-INF')) continue;

      const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
      const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/i);
      const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
      const pixels = resMatch ? parseInt(resMatch[1], 10) * parseInt(resMatch[2], 10) : 0;
      const score = pixels * 1000 + bw;

      // Next non-empty non-comment line is the variant URI
      let uri = '';
      for (let j = i + 1; j < lines.length; j++) {
        const candidate = lines[j].trim();
        if (candidate && !candidate.startsWith('#')) {
          uri = candidate;
          break;
        }
      }

      if (uri && score > bestScore) {
        bestScore = score;
        bestVariant = resolveRelativeUrl(playlistUrl, uri);
      }
    }

    if (!bestVariant) throw new Error('No playable HLS variant found.');
    const varRes = await fetch(bestVariant);
    if (!varRes.ok) throw new Error(`HLS variant fetch failed (${varRes.status})`);
    playlistText = await varRes.text();
    playlistUrl = varRes.url || bestVariant;
  }

  // Parse media playlist: check for fMP4 init segment (#EXT-X-MAP:URI="...") and all media segments
  const lines = playlistText.split(/\r?\n/);
  const segmentUrls = [];
  let isFmp4 = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MAP:')) {
      const uriMatch = line.match(/URI="([^"]+)"/i);
      if (uriMatch) {
        isFmp4 = true;
        segmentUrls.push(resolveRelativeUrl(playlistUrl, uriMatch[1]));
      }
      continue;
    }
    if (line.startsWith('#')) continue;
    if (/\.m4s(\?|$)/i.test(line) || /\.mp4(\?|$)/i.test(line)) isFmp4 = true;
    segmentUrls.push(resolveRelativeUrl(playlistUrl, line));
  }

  if (segmentUrls.length === 0) throw new Error('HLS playlist contained no segments.');

  // Download segments in parallel batches of 6
  const buffers = new Array(segmentUrls.length);
  const BATCH_SIZE = 6;
  for (let i = 0; i < segmentUrls.length; i += BATCH_SIZE) {
    const batch = segmentUrls.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (segUrl) => {
        const r = await fetch(segUrl);
        if (!r.ok) throw new Error(`Segment download failed (${r.status})`);
        return new Uint8Array(await r.arrayBuffer());
      })
    );
    for (let j = 0; j < results.length; j++) {
      buffers[i + j] = results[j];
    }
  }

  return {
    buffers,
    ext: isFmp4 ? 'mp4' : 'ts',
    mime: isFmp4 ? 'video/mp4' : 'video/mp2t',
  };
}

function uint8ToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// 9. Message Handler (Content Script <-> Background Service Worker)
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'DOWNLOAD_PIN') return false;

  (async () => {
    try {
      const tabId = sender?.tab?.id ?? -1;
      const settings = await getSettings();
      const resolved = await resolvePinMedia(message.payload || {}, tabId);

      if (resolved.mode === 'direct') {
        const filename = buildFilename(resolved.pinId, resolved.title, resolved.ext, settings.useSubfolder);
        const downloadId = await chrome.downloads.download({
          url: resolved.url,
          filename,
          conflictAction: 'uniquify',
          saveAs: false,
        });
        await recordDownload(filename);
        sendResponse({ ok: true, kind: resolved.kind, mode: 'direct', filename, downloadId });
        return;
      }

      if (resolved.mode === 'hls') {
        const hls = await fetchHlsSegments(resolved.url);
        const filename = buildFilename(resolved.pinId, resolved.title, hls.ext, settings.useSubfolder);

        // Stream chunks to content script via port so content script creates Blob URL cleanly in MV3
        if (tabId >= 0) {
          const port = chrome.tabs.connect(tabId, { name: 'pinvault-hls-transfer' });
          port.postMessage({
            type: 'HLS_START',
            filename: filename.split('/').pop(),
            mime: hls.mime,
            totalSegments: hls.buffers.length,
          });
          for (const seg of hls.buffers) {
            port.postMessage({ type: 'HLS_CHUNK', b64: uint8ToBase64(seg) });
          }
          port.postMessage({ type: 'HLS_END' });
          await recordDownload(filename);
          sendResponse({ ok: true, kind: 'video', mode: 'hls', filename });
          return;
        }
        throw new Error('Could not connect to tab for HLS assembly.');
      }

      throw new Error('Unsupported media mode.');
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || 'Download failed.' });
    }
  })();

  return true; // Keep message channel open for async response
});
