// PinVault v2.2 — Content Script
// Single top-layer floating overlay button with strict singleton deduplication.

(() => {
  'use strict';

  // Prevent double initialization in the same frame
  if (window.__PINVAULT_INITIALIZED__) return;
  window.__PINVAULT_INITIALIZED__ = true;

  // Remove any stale or duplicate download buttons from earlier versions/reloads
  document.querySelectorAll('#pinvault-floating-btn, .pinvault-dl-btn').forEach((el) => el.remove());

  const MIN_MEDIA_SIZE = 90;

  const ICON_DOWNLOAD = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
  const ICON_SPINNER = `<svg class="pinvault-spin" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 2a10 10 0 1 0 10 10"/></svg>`;
  const ICON_CHECK = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  const ICON_ERROR = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;

  // -------------------------------------------------------------------------
  // 1. HLS Blob Assembly Receiver (Port from Background Service Worker)
  // -------------------------------------------------------------------------
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'pinvault-hls-transfer') return;
    let filename = `pinterest_video_${Date.now()}.mp4`;
    let mime = 'video/mp4';
    const chunks = [];

    port.onMessage.addListener((msg) => {
      if (msg.type === 'HLS_START') {
        filename = msg.filename || filename;
        mime = msg.mime || mime;
      } else if (msg.type === 'HLS_CHUNK' && msg.b64) {
        const bin = atob(msg.b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        chunks.push(bytes);
      } else if (msg.type === 'HLS_END') {
        try {
          const blob = new Blob(chunks, { type: mime });
          const blobUrl = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = blobUrl;
          a.download = filename;
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            a.remove();
            URL.revokeObjectURL(blobUrl);
          }, 4000);
        } catch (_) {
          showToast('Failed to assemble HLS video.', true);
        }
        port.disconnect();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2. Toast Notification
  // -------------------------------------------------------------------------
  let toastTimer = null;
  function showToast(text, isError = false) {
    let toast = document.getElementById('pinvault-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'pinvault-toast';
      document.documentElement.appendChild(toast);
    }
    toast.textContent = text;
    toast.className = isError ? 'pinvault-toast pinvault-toast-err show' : 'pinvault-toast show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('show');
    }, 2800);
  }

  // -------------------------------------------------------------------------
  // 3. Pin & Media Detection Helpers
  // -------------------------------------------------------------------------
  function extractPinIdFromUrl(url) {
    if (!url) return null;
    const m = url.match(/\/pin\/(\d{5,25})/);
    return m ? m[1] : null;
  }

  function extractPinIdFromElement(el) {
    if (!el) return extractPinIdFromUrl(location.href);

    let cur = el;
    for (let i = 0; i < 10 && cur; i++, cur = cur.parentElement) {
      const attrId =
        cur.getAttribute?.('data-test-pin-id') ||
        cur.getAttribute?.('data-pin-id');
      if (attrId && /^\d{5,25}$/.test(attrId)) return attrId;

      if (cur.tagName === 'A' && cur.href) {
        const fromHref = extractPinIdFromUrl(cur.href);
        if (fromHref) return fromHref;
      }

      if (
        cur.getAttribute?.('data-test-id') === 'pin' ||
        cur.getAttribute?.('data-test-id') === 'pinWrapper' ||
        cur.getAttribute?.('data-grid-item') === 'true'
      ) {
        const link = cur.querySelector('a[href*="/pin/"]');
        if (link) {
          const fromLink = extractPinIdFromUrl(link.getAttribute('href') || link.href);
          if (fromLink) return fromLink;
        }
      }
    }

    const innerLink = el.querySelector?.('a[href*="/pin/"]');
    if (innerLink) {
      const fromInner = extractPinIdFromUrl(innerLink.getAttribute('href') || innerLink.href);
      if (fromInner) return fromInner;
    }

    return extractPinIdFromUrl(location.href);
  }

  function pickLargestSrcFromSrcset(img) {
    const srcset = img.getAttribute('srcset');
    if (!srcset) return img.currentSrc || img.src || '';
    let bestUrl = img.currentSrc || img.src || '';
    let bestWidth = 0;

    for (const part of srcset.split(',')) {
      const tokens = part.trim().split(/\s+/);
      if (tokens.length < 1) continue;
      const url = tokens[0];
      const descriptor = tokens[1] || '';
      const w = parseInt(descriptor, 10) || (descriptor.endsWith('x') ? parseFloat(descriptor) * 1000 : 0);
      if (w > bestWidth) {
        bestWidth = w;
        bestUrl = url;
      }
    }
    return bestUrl;
  }

  function isValidMediaElement(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag !== 'IMG' && tag !== 'VIDEO') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < MIN_MEDIA_SIZE || rect.height < MIN_MEDIA_SIZE) return false;
    if (tag === 'IMG') {
      const src = el.currentSrc || el.src || '';
      if (!src || src.startsWith('data:image/svg') || src.includes('/75x75') || src.includes('/30x30')) {
        return false;
      }
    }
    return true;
  }

  const CARD_SELECTORS = [
    '[data-test-id="pinWrapper"]',
    '[data-test-id="pin"]',
    '[data-grid-item="true"]',
    '[data-test-id="closeup-body-image-container"]',
    '[data-test-id="pin-closeup-image"]',
    '[data-test-id="story-pin-image-block"]',
    '[data-test-id="story-pin-video-block"]',
    '[data-test-id="video-snippet"]',
    '[data-test-id="visual-content-container"]',
  ].join(',');

  function findTargetUnderCursor(x, y) {
    const stack = document.elementsFromPoint(x, y);
    let mediaEl = null;
    let cardEl = null;

    for (const el of stack) {
      if (el.id === 'pinvault-floating-btn' || el.closest?.('#pinvault-floating-btn')) {
        return { keepCurrent: true };
      }
      if (!mediaEl && isValidMediaElement(el)) {
        mediaEl = el;
      }
      if (!cardEl && el.matches?.(CARD_SELECTORS)) {
        cardEl = el;
      }
      if (mediaEl && cardEl) break;
    }

    if (!mediaEl && cardEl) {
      const candidates = Array.from(cardEl.querySelectorAll('video, img')).filter(isValidMediaElement);
      for (const cand of candidates) {
        const r = cand.getBoundingClientRect();
        if (x >= r.left - 8 && x <= r.right + 8 && y >= r.top - 8 && y <= r.bottom + 8) {
          mediaEl = cand;
          break;
        }
      }
      if (!mediaEl && candidates.length > 0) {
        candidates.sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return rb.width * rb.height - ra.width * ra.height;
        });
        mediaEl = candidates[0];
      }
    }

    if (!mediaEl) return null;
    const container = cardEl || mediaEl.closest(CARD_SELECTORS) || mediaEl.parentElement || mediaEl;
    return { mediaEl, container };
  }

  function inspectMediaContext(mediaEl, container) {
    const scope = container || mediaEl;
    const videoEl = mediaEl.tagName === 'VIDEO' ? mediaEl : scope.querySelector?.('video');
    const imgEl = mediaEl.tagName === 'IMG'
      ? mediaEl
      : Array.from(scope.querySelectorAll?.('img') || []).find(isValidMediaElement) || null;

    const hasVideoTestId = Boolean(
      scope.querySelector?.(
        '[data-test-id="pinrep-video-duration"], [data-test-id="video-snippet"], [data-test-id="story-pin-video-block"], [data-test-id="video-player"]'
      )
    );
    const hasDurationText = Array.from(scope.querySelectorAll?.('div, span') || []).some((el) => {
      if (el.children.length > 0) return false;
      return /^\d{1,2}:\d{2}$/.test((el.textContent || '').trim());
    });

    const isVideo = Boolean(videoEl || hasVideoTestId || hasDurationText);

    let videoUrl = '';
    if (videoEl) {
      videoUrl = videoEl.currentSrc || videoEl.src || '';
      if (!videoUrl || videoUrl.startsWith('blob:')) {
        const srcEl = videoEl.querySelector('source[src]');
        if (srcEl) videoUrl = srcEl.src;
      }
    }

    const imgUrl = imgEl ? pickLargestSrcFromSrcset(imgEl) : videoEl?.poster || '';
    const title =
      imgEl?.alt ||
      scope.querySelector?.('h1, [data-test-id="pinTitle"]')?.textContent?.trim() ||
      '';
    const pinId = extractPinIdFromElement(scope) || extractPinIdFromElement(mediaEl);

    return {
      isVideo,
      mediaType: isVideo ? 'video' : 'auto',
      videoUrl,
      imgUrl,
      title,
      pinId,
    };
  }

  // -------------------------------------------------------------------------
  // 4. Single Floating Overlay Button
  // -------------------------------------------------------------------------
  const btn = document.createElement('button');
  btn.id = 'pinvault-floating-btn';
  btn.type = 'button';
  btn.className = 'pinvault-dl-btn';
  btn.innerHTML = `${ICON_DOWNLOAD}<span class="pinvault-label">HD</span>`;
  document.documentElement.appendChild(btn);

  function removeForeignDuplicates() {
    document.querySelectorAll('.pinvault-dl-btn').forEach((el) => {
      if (el !== btn) el.remove();
    });
  }

  let activeMediaEl = null;
  let activeContainer = null;
  let activeContext = null;
  let hideTimer = null;
  let isBusy = false;

  function positionButtonForElement(el) {
    removeForeignDuplicates();
    if (!el || !el.isConnected) {
      hideButton();
      return;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width < MIN_MEDIA_SIZE || rect.height < MIN_MEDIA_SIZE || rect.bottom < 0 || rect.top > window.innerHeight) {
      hideButton();
      return;
    }

    const btnHeight = 36;
    const left = Math.max(8, Math.min(rect.left + 12, window.innerWidth - 130));
    const top = Math.max(8, Math.min(rect.bottom - btnHeight - 12, window.innerHeight - btnHeight - 8));

    btn.style.left = `${Math.round(left)}px`;
    btn.style.top = `${Math.round(top)}px`;
    btn.classList.add('pinvault-visible');
  }

  function hideButton() {
    if (isBusy) return;
    btn.classList.remove('pinvault-visible');
    activeMediaEl = null;
    activeContainer = null;
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!btn.matches(':hover') && !isBusy) {
        hideButton();
      }
    }, 180);
  }

  let rafPending = false;
  let lastX = 0;
  let lastY = 0;

  document.addEventListener(
    'pointermove',
    (e) => {
      lastX = e.clientX;
      lastY = e.clientY;
      if (rafPending) return;
      rafPending = true;

      requestAnimationFrame(() => {
        rafPending = false;
        const found = findTargetUnderCursor(lastX, lastY);

        if (!found) {
          scheduleHide();
          return;
        }
        if (found.keepCurrent) {
          clearTimeout(hideTimer);
          return;
        }

        clearTimeout(hideTimer);
        const changed = found.mediaEl !== activeMediaEl;
        activeMediaEl = found.mediaEl;
        activeContainer = found.container;

        if (changed && !isBusy) {
          activeContext = inspectMediaContext(activeMediaEl, activeContainer);
          btn.classList.remove('pinvault-done', 'pinvault-err');
          btn.innerHTML = `${ICON_DOWNLOAD}<span class="pinvault-label">${activeContext.isVideo ? 'HD Video' : 'HD'}</span>`;
          btn.title = activeContext.isVideo ? 'Download highest-quality video' : 'Download highest-quality image';
        }

        positionButtonForElement(activeMediaEl);
      });
    },
    { passive: true, capture: true }
  );

  window.addEventListener(
    'scroll',
    () => {
      if (activeMediaEl && btn.classList.contains('pinvault-visible')) {
        positionButtonForElement(activeMediaEl);
      }
    },
    { passive: true, capture: true }
  );

  window.addEventListener('resize', () => {
    if (activeMediaEl && btn.classList.contains('pinvault-visible')) {
      positionButtonForElement(activeMediaEl);
    }
  });

  btn.addEventListener('pointerenter', () => clearTimeout(hideTimer));
  btn.addEventListener('pointerleave', () => scheduleHide());

  const stopAll = (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };
  btn.addEventListener('pointerdown', stopAll, true);
  btn.addEventListener('mousedown', stopAll, true);

  btn.addEventListener('click', (e) => {
    stopAll(e);
    if (isBusy || !activeMediaEl) return;

    const fresh = inspectMediaContext(activeMediaEl, activeContainer);
    if (!fresh.imgUrl && !fresh.videoUrl && !fresh.pinId) {
      showToast('Could not detect media for this pin.', true);
      return;
    }

    isBusy = true;
    btn.classList.remove('pinvault-done', 'pinvault-err');
    btn.classList.add('pinvault-busy', 'pinvault-visible');
    btn.innerHTML = `${ICON_SPINNER}<span class="pinvault-label">Saving…</span>`;

    chrome.runtime.sendMessage(
      {
        type: 'DOWNLOAD_PIN',
        payload: {
          pinId: fresh.pinId,
          mediaType: fresh.mediaType,
          imgUrl: fresh.imgUrl,
          videoUrl: fresh.videoUrl,
          pageUrl: location.href,
          title: fresh.title,
        },
      },
      (resp) => {
        isBusy = false;
        btn.classList.remove('pinvault-busy');

        if (chrome.runtime.lastError || !resp || !resp.ok) {
          const errMsg = chrome.runtime.lastError?.message || resp?.error || 'Download failed.';
          btn.classList.add('pinvault-err');
          btn.innerHTML = `${ICON_ERROR}<span class="pinvault-label">Retry</span>`;
          showToast(`PinVault: ${errMsg}`, true);
          setTimeout(() => {
            btn.classList.remove('pinvault-err');
            btn.innerHTML = `${ICON_DOWNLOAD}<span class="pinvault-label">${fresh.isVideo ? 'HD Video' : 'HD'}</span>`;
          }, 2500);
          return;
        }

        btn.classList.add('pinvault-done');
        btn.innerHTML = `${ICON_CHECK}<span class="pinvault-label">Saved</span>`;
        showToast(resp.kind === 'video' ? 'Saved HD video to Downloads' : 'Saved HD image to Downloads');
        setTimeout(() => {
          btn.classList.remove('pinvault-done');
          btn.innerHTML = `${ICON_DOWNLOAD}<span class="pinvault-label">${fresh.isVideo || resp.kind === 'video' ? 'HD Video' : 'HD'}</span>`;
        }, 2000);
      }
    );
  });
})();
