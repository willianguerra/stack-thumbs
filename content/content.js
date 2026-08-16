/**
 * Content script: varre o DOM do YouTube e devolve os vídeos encontrados.
 *
 * Roda sob demanda (quando o popup pede) — sem MutationObserver permanente,
 * sem dependência de DOMContentLoaded, o que o torna imune à navegação SPA
 * do YouTube: o DOM é sempre lido no instante da requisição.
 *
 * Depende de shared/protocol.js e shared/youtube.js, carregados antes dele.
 */
(function initThumbnailCollector() {
  'use strict';

  // A injeção programática (fallback do popup) pode rodar sobre um content
  // script já declarado no manifest. Evita listener duplicado.
  if (globalThis.__ytdThumbnailCollectorReady) return;
  globalThis.__ytdThumbnailCollectorReady = true;

  const { PING, COLLECT, MODE_ALL, MODE_VISIBLE } = globalThis.YTD_PROTOCOL;
  const { extractYouTubeVideoId, buildVideoUrl } = globalThis.YTD_YOUTUBE;

  /**
   * Âncoras de vídeo. Deliberadamente baseado em href — não em classes CSS
   * internas do YouTube, que mudam sem aviso.
   */
  const ANCHOR_SELECTOR = [
    'a[href*="/watch?v="]',
    'a[href*="/shorts/"]',
    'a[href*="youtu.be/"]',
    'a[href*="/embed/"]'
  ].join(', ');

  /**
   * Tags de card conhecidas do YouTube. São *dicas*, não requisito: se nenhuma
   * casar, o fallback geométrico assume.
   */
  const CARD_TAGS = new Set([
    'YTD-RICH-ITEM-RENDERER',
    'YTD-VIDEO-RENDERER',
    'YTD-GRID-VIDEO-RENDERER',
    'YTD-COMPACT-VIDEO-RENDERER',
    'YTD-PLAYLIST-VIDEO-RENDERER',
    'YTD-PLAYLIST-PANEL-VIDEO-RENDERER',
    'YTD-REEL-ITEM-RENDERER',
    'YTD-RICH-GRID-MEDIA',
    'YTD-GRID-MOVIE-RENDERER',
    'YTD-MOVIE-RENDERER',
    'YTD-VIDEO-PREVIEW',
    'YTD-CHILD-VIDEO-RENDERER',
    'YT-LOCKUP-VIEW-MODEL',
    'SHORTS-LOCKUP-VIEW-MODEL',
    'SHORTS-LOCKUP-VIEW-MODEL-V2',
    'YTM-VIDEO-WITH-CONTEXT-RENDERER',
    'YTM-COMPACT-VIDEO-RENDERER',
    'YTM-ITEM-SECTION-RENDERER'
  ]);

  /**
   * Seletores de título, em ordem de confiança. Os `id`s do YouTube são bem
   * mais estáveis que as classes.
   */
  const TITLE_SELECTORS = [
    '#video-title',
    'a#video-title-link',
    'h3 a[title]',
    '[class*="lockup-metadata-view-model__title"]',
    'h3 span[role="text"]',
    'h3',
    '[title]:not(img)'
  ];

  /** Não vale a pena escanear páginas absurdamente grandes por inteiro. */
  const MAX_ANCHORS = 4000;
  /** Cards menores que isso são links de texto, não thumbnails. */
  const MIN_CARD_WIDTH = 40;
  const MIN_CARD_HEIGHT = 30;

  function getViewportSize() {
    return {
      width: window.innerWidth || document.documentElement.clientWidth || 0,
      height: window.innerHeight || document.documentElement.clientHeight || 0
    };
  }

  /**
   * Mede a interseção do card com o viewport.
   * Visível = ao menos parcialmente dentro da tela.
   */
  function measureVisibility(rect, viewport) {
    const overlapX = Math.max(0, Math.min(rect.right, viewport.width) - Math.max(rect.left, 0));
    const overlapY = Math.max(0, Math.min(rect.bottom, viewport.height) - Math.max(rect.top, 0));
    const area = rect.width * rect.height;
    const ratio = area > 0 ? (overlapX * overlapY) / area : 0;
    return { visible: overlapX > 0 && overlapY > 0, ratio: Math.min(1, ratio) };
  }

  /** Elementos que só existem em cards de vídeo de verdade. */
  const THUMBNAIL_MARKER_SELECTOR = [
    'ytd-thumbnail',
    'yt-thumbnail-view-model',
    'ytm-thumbnail-cover',
    'img[src*="/vi/"]',
    'img[src*="/vi_webp/"]',
    'img[srcset*="/vi/"]'
  ].join(', ');

  /**
   * Sobe a árvore procurando o container do card.
   * 1) tag conhecida do YouTube; 2) fallback geométrico (primeiro ancestral
   * com tamanho de card). Nunca depende só de classes CSS.
   *
   * @returns {{element:Element, byTag:boolean}}
   */
  function findCardElement(anchor, viewport) {
    let node = anchor;
    for (let depth = 0; depth < 12 && node && node !== document.body; depth += 1) {
      if (CARD_TAGS.has(node.tagName)) return { element: node, byTag: true };
      node = node.parentElement;
    }

    node = anchor;
    for (let depth = 0; depth < 6 && node && node !== document.body; depth += 1) {
      const rect = node.getBoundingClientRect();
      const withinViewportBounds =
        rect.width <= viewport.width && rect.height <= Math.max(viewport.height, 1);
      if (rect.width >= 100 && rect.height >= 60 && withinViewportBounds) {
        return { element: node, byTag: false };
      }
      node = node.parentElement;
    }

    return { element: anchor, byTag: false };
  }

  /**
   * Um link para /watch?v= dentro de um comentário ou de uma descrição não é
   * um card. Cards reais sempre carregam uma thumbnail.
   */
  function isThumbnailCard(card, anchor) {
    try {
      if (anchor.querySelector('img, ytd-thumbnail, yt-image')) return true;
      return Boolean(card.querySelector(THUMBNAIL_MARKER_SELECTOR));
    } catch (_) {
      return false;
    }
  }

  function normalizeText(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim().slice(0, 300);
  }

  /** Ignora textos que claramente não são título (duração, badges). */
  function looksLikeTitle(text) {
    // Um único caractere é um título válido ("A", "9"), então só o vazio sai.
    if (!text) return false;
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(text)) return false;
    if (/^(ao vivo|live|shorts|novo|new)$/i.test(text)) return false;
    return true;
  }

  /** Extrai o título tentando várias fontes, da mais confiável para a menos. */
  function extractTitle(card, anchor) {
    const anchorTitle = normalizeText(anchor.getAttribute('title'));
    if (looksLikeTitle(anchorTitle)) return anchorTitle;

    for (const selector of TITLE_SELECTORS) {
      let node = null;
      try {
        node = card.querySelector(selector);
      } catch (_) {
        continue;
      }
      if (!node) continue;

      const fromAttr = normalizeText(node.getAttribute && node.getAttribute('title'));
      if (looksLikeTitle(fromAttr)) return fromAttr;

      const fromText = normalizeText(node.textContent);
      if (looksLikeTitle(fromText)) return fromText;

      const fromAria = normalizeText(node.getAttribute && node.getAttribute('aria-label'));
      if (looksLikeTitle(fromAria)) return fromAria;
    }

    const anchorAria = normalizeText(anchor.getAttribute('aria-label'));
    if (looksLikeTitle(anchorAria)) return anchorAria;

    const image = card.querySelector('img[alt]');
    const fromAlt = image ? normalizeText(image.getAttribute('alt')) : '';
    if (looksLikeTitle(fromAlt)) return fromAlt;

    const fromAnchorText = normalizeText(anchor.textContent);
    if (looksLikeTitle(fromAnchorText)) return fromAnchorText;

    return '';
  }

  /**
   * Thumbnail já renderizada pelo YouTube. Serve só de preview instantâneo no
   * popup (já está no cache do browser); a versão de alta resolução é
   * resolvida depois.
   */
  function extractPageThumbnail(card, videoId) {
    const images = card.querySelectorAll('img');
    for (const image of images) {
      const src = image.currentSrc || image.src || '';
      if (!src || src.startsWith('data:')) continue;
      if (src.includes('/vi/') || src.includes('/vi_webp/') || src.includes('ytimg.com')) {
        if (!videoId || src.includes(videoId)) return src;
      }
    }
    return '';
  }

  /**
   * Decide qual das duas ocorrências do mesmo vídeo fica.
   * Prioriza: visível > área maior. Campos ausentes são completados.
   */
  function mergeEntries(existing, candidate) {
    const existingArea = existing.width * existing.height;
    const candidateArea = candidate.width * candidate.height;

    let winner = existing;
    let loser = candidate;
    if ((candidate.visible && !existing.visible) ||
        (candidate.visible === existing.visible && candidateArea > existingArea)) {
      winner = candidate;
      loser = existing;
    }

    if (!winner.title && loser.title) winner.title = loser.title;
    if (!winner.pageThumbnailUrl && loser.pageThumbnailUrl) {
      winner.pageThumbnailUrl = loser.pageThumbnailUrl;
    }
    winner.visibleRatio = Math.max(existing.visibleRatio, candidate.visibleRatio);
    winner.occurrences = (existing.occurrences || 1) + 1;
    return winner;
  }

  /**
   * Ordena na mesma ordem visual da página: cima -> baixo, esquerda -> direita.
   * Agrupa em linhas com tolerância proporcional à altura dos cards para que
   * um grid não fique embaralhado por diferenças de poucos pixels.
   */
  function sortByVisualOrder(entries) {
    if (entries.length < 2) return entries;

    const heights = entries.map((entry) => entry.height).sort((a, b) => a - b);
    const medianHeight = heights[Math.floor(heights.length / 2)] || 0;
    const rowTolerance = Math.max(40, medianHeight * 0.5);

    const byTop = entries.slice().sort((a, b) => a.top - b.top || a.left - b.left);

    let rowIndex = 0;
    let rowAnchorTop = byTop.length ? byTop[0].top : 0;
    for (const entry of byTop) {
      if (entry.top - rowAnchorTop > rowTolerance) {
        rowIndex += 1;
        rowAnchorTop = entry.top;
      }
      entry.row = rowIndex;
    }

    return byTop.sort((a, b) => a.row - b.row || a.left - b.left || a.top - b.top);
  }

  /**
   * Coleta os vídeos do DOM atual.
   * @param {string} mode 'visible' (padrão) ou 'all'
   */
  function collectVideos(mode) {
    const captureAll = mode === MODE_ALL;
    const viewport = getViewportSize();
    const byVideoId = new Map();

    let anchors;
    try {
      anchors = document.querySelectorAll(ANCHOR_SELECTOR);
    } catch (_) {
      anchors = [];
    }

    let scanned = 0;
    for (const anchor of anchors) {
      if (scanned >= MAX_ANCHORS) break;
      scanned += 1;

      let entry;
      try {
        const href = anchor.getAttribute('href') || anchor.href || '';
        const videoId = extractYouTubeVideoId(href);
        if (!videoId) continue;

        const { element: card, byTag } = findCardElement(anchor, viewport);
        if (!byTag && !isThumbnailCard(card, anchor)) continue;

        let rect = card.getBoundingClientRect();

        // Card colapsado (item reciclado pelo virtual scroller): tenta a âncora.
        if (rect.width < MIN_CARD_WIDTH || rect.height < MIN_CARD_HEIGHT) {
          const anchorRect = anchor.getBoundingClientRect();
          if (anchorRect.width < 1 || anchorRect.height < 1) continue;
          rect = anchorRect;
        }

        const visibility = measureVisibility(rect, viewport);
        if (!captureAll && !visibility.visible) continue;

        entry = {
          videoId,
          title: extractTitle(card, anchor),
          videoUrl: buildVideoUrl(videoId),
          pageThumbnailUrl: extractPageThumbnail(card, videoId),
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          visible: visibility.visible,
          visibleRatio: Number(visibility.ratio.toFixed(3)),
          occurrences: 1
        };
      } catch (_) {
        // Um card malformado nunca deve derrubar a varredura inteira.
        continue;
      }

      const existing = byVideoId.get(entry.videoId);
      byVideoId.set(entry.videoId, existing ? mergeEntries(existing, entry) : entry);
    }

    const ordered = sortByVisualOrder(Array.from(byVideoId.values()));
    ordered.forEach((entry, index) => {
      entry.position = index + 1;
      delete entry.row;
    });

    return {
      videos: ordered,
      total: ordered.length,
      visibleCount: ordered.filter((entry) => entry.visible).length,
      mode: captureAll ? MODE_ALL : MODE_VISIBLE,
      pageUrl: location.href,
      pageTitle: document.title,
      scannedAnchors: scanned
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;

    if (message.type === PING) {
      sendResponse({ ok: true, ready: true });
      return false;
    }

    if (message.type === COLLECT) {
      try {
        sendResponse({ ok: true, ...collectVideos(message.mode) });
      } catch (error) {
        sendResponse({ ok: false, error: String((error && error.message) || error) });
      }
      return false;
    }

    return false;
  });
})();
