/**
 * Utilitários de YouTube: extração de videoId e catálogo de thumbnails.
 *
 * Script clássico compartilhado (ver shared/protocol.js para o motivo).
 */
(function attachYouTubeUtils(global) {
  'use strict';

  /** IDs de vídeo do YouTube têm exatamente 11 caracteres base64url. */
  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

  /** Segmentos de path que são seguidos diretamente pelo videoId. */
  const PATH_PREFIXES = ['shorts', 'embed', 'live', 'v', 'watch'];

  /**
   * Último recurso: procura o id em qualquer lugar da string.
   * O lookahead exige um delimitador real depois do id — sem isso, um id
   * malformado como "?v=notavalidid!!" seria truncado para 11 caracteres e
   * aceito como se fosse válido.
   */
  const LOOSE_PATTERNS = [
    /[?&]v=([A-Za-z0-9_-]{11})(?=$|[\s&#"'<>])/,
    /\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})(?=$|[\s/?&#"'<>])/,
    /youtu\.be\/([A-Za-z0-9_-]{11})(?=$|[\s/?&#"'<>])/
  ];

  /**
   * Variantes de thumbnail, da maior para a menor.
   *
   * `minWidth` protege contra o placeholder cinza 120x90 que o YouTube às vezes
   * devolve no lugar de um 404 quando a variante não existe.
   */
  const THUMBNAIL_VARIANTS = Object.freeze([
    { key: 'maxresdefault', label: 'maxres', nominal: '1280 × 720', minWidth: 1000, minHeight: 550 },
    { key: 'sddefault', label: 'sd', nominal: '640 × 480', minWidth: 600, minHeight: 400 },
    { key: 'hqdefault', label: 'hq', nominal: '480 × 360', minWidth: 400, minHeight: 300 },
    { key: 'mqdefault', label: 'mq', nominal: '320 × 180', minWidth: 280, minHeight: 150 }
  ].map(Object.freeze));

  /** Hosts que servem thumbnails. */
  const THUMBNAIL_HOST = 'https://i.ytimg.com';

  function isValidVideoId(candidate) {
    return typeof candidate === 'string' && VIDEO_ID_RE.test(candidate);
  }

  /**
   * Extrai o videoId de praticamente qualquer formato de URL do YouTube.
   *
   * Aceita: https://www.youtube.com/watch?v=ID, /watch?v=ID, https://youtu.be/ID,
   * /shorts/ID, /embed/ID, /live/ID, /v/ID e o próprio ID isolado.
   *
   * @param {string} url
   * @returns {string|null} videoId de 11 caracteres ou null.
   */
  function extractYouTubeVideoId(url) {
    if (typeof url !== 'string') return null;
    const raw = url.trim();
    if (!raw) return null;

    // O próprio id, já isolado.
    if (VIDEO_ID_RE.test(raw)) return raw;

    let parsed = null;
    try {
      // A base cobre hrefs relativos como "/watch?v=ID".
      parsed = new URL(raw, 'https://www.youtube.com');
    } catch (_) {
      parsed = null;
    }

    if (parsed) {
      const host = parsed.hostname.toLowerCase();
      const segments = parsed.pathname.split('/').filter(Boolean);

      // youtu.be/ID
      if (host === 'youtu.be' || host.endsWith('.youtu.be')) {
        if (isValidVideoId(segments[0])) return segments[0];
      }

      // ...?v=ID
      const queryId = parsed.searchParams.get('v');
      if (isValidVideoId(queryId)) return queryId;

      // /shorts/ID, /embed/ID, /live/ID, /v/ID
      for (let i = 0; i < segments.length - 1; i += 1) {
        if (PATH_PREFIXES.includes(segments[i].toLowerCase()) && isValidVideoId(segments[i + 1])) {
          return segments[i + 1];
        }
      }
    }

    for (const pattern of LOOSE_PATTERNS) {
      const match = raw.match(pattern);
      if (match && isValidVideoId(match[1])) return match[1];
    }

    return null;
  }

  /**
   * Monta a URL de uma variante de thumbnail.
   * @param {string} videoId
   * @param {string} variantKey ex.: "maxresdefault"
   * @returns {string|null}
   */
  function buildThumbnailUrl(videoId, variantKey) {
    if (!isValidVideoId(videoId)) return null;
    const key = variantKey || THUMBNAIL_VARIANTS[0].key;
    return `${THUMBNAIL_HOST}/vi/${videoId}/${key}.jpg`;
  }

  /**
   * Verifica se as dimensões carregadas correspondem a uma imagem real
   * (e não ao placeholder que o YouTube devolve para variantes inexistentes).
   * @param {{minWidth:number,minHeight:number}} variant
   * @param {number} width
   * @param {number} height
   */
  function isRealThumbnail(variant, width, height) {
    if (!variant || !width || !height) return false;
    // O placeholder clássico é exatamente 120x90.
    if (width === 120 && height === 90) return false;
    return width >= variant.minWidth && height >= variant.minHeight;
  }

  /** URL canônica do vídeo a partir do id. */
  function buildVideoUrl(videoId) {
    return isValidVideoId(videoId) ? `https://www.youtube.com/watch?v=${videoId}` : null;
  }

  /** Verifica se uma URL é uma página do YouTube onde a extensão funciona. */
  function isSupportedYouTubeUrl(url) {
    if (typeof url !== 'string' || !url) return false;
    try {
      const { protocol, hostname } = new URL(url);
      if (protocol !== 'https:' && protocol !== 'http:') return false;
      const host = hostname.toLowerCase();
      return host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com';
    } catch (_) {
      return false;
    }
  }

  global.YTD_YOUTUBE = Object.freeze({
    VIDEO_ID_RE,
    THUMBNAIL_VARIANTS,
    THUMBNAIL_HOST,
    isValidVideoId,
    extractYouTubeVideoId,
    buildThumbnailUrl,
    buildVideoUrl,
    isRealThumbnail,
    isSupportedYouTubeUrl
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
