/**
 * Geração de nomes de arquivo seguros para Windows/macOS/Linux.
 *
 * Script clássico compartilhado (ver shared/protocol.js para o motivo).
 */
(function attachFilenameUtils(global) {
  'use strict';

  /** Caracteres proibidos no Windows: < > : " / \ | ? * */
  const ILLEGAL_CHARS_RE = /[<>:"/\\|?*]/g;
  /** Caracteres de controle (00-1F e 7F). */
  const CONTROL_CHARS_RE = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');
  /** Espaços de largura zero e BOM. */
  const ZERO_WIDTH_RE = new RegExp('[\\u200b-\\u200d\\ufeff]', 'g');
  /** Nomes reservados pelo Windows. */
  const RESERVED_NAMES_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

  const DEFAULT_MAX_LENGTH = 80;

  /**
   * Limpa um texto para uso como nome de arquivo.
   * @param {string} input
   * @param {{maxLength?:number, fallback?:string}} [options]
   * @returns {string} nunca vazio
   */
  function sanitizeFilename(input, options) {
    const maxLength = (options && options.maxLength) || DEFAULT_MAX_LENGTH;
    const fallback = (options && options.fallback) || 'thumbnail';

    let name = String(input == null ? '' : input)
      .replace(CONTROL_CHARS_RE, ' ')
      .replace(ZERO_WIDTH_RE, '')
      .replace(ILLEGAL_CHARS_RE, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (name.length > maxLength) {
      name = name.slice(0, maxLength).trim();
    }

    // Windows não aceita nome terminado em ponto ou espaço.
    name = name.replace(/[. ]+$/, '').trim();

    if (!name) return fallback;
    if (RESERVED_NAMES_RE.test(name)) return `_${name}`;
    return name;
  }

  /**
   * Monta "01 - titulo-do-video.jpg" preservando a ordem visual.
   *
   * @param {{index:number, total?:number, title?:string, videoId?:string, extension?:string}} item
   * @returns {string}
   */
  function buildThumbnailFilename(item) {
    const index = Number.isFinite(item && item.index) ? item.index : 1;
    const total = Number.isFinite(item && item.total) ? item.total : index;
    const padding = Math.max(2, String(Math.max(total, index)).length);
    const prefix = String(index).padStart(padding, '0');

    const fallback = sanitizeFilename(item && item.videoId, { fallback: 'thumbnail' });
    const base = sanitizeFilename(item && item.title, { fallback });
    const extension = (item && item.extension) || 'jpg';

    return `${prefix} - ${base}.${extension}`;
  }

  /** Extrai a extensão da URL da thumbnail (default: jpg). */
  function extensionFromUrl(url) {
    try {
      const { pathname } = new URL(url);
      const match = pathname.match(/\.([a-z0-9]{2,4})$/i);
      return match ? match[1].toLowerCase() : 'jpg';
    } catch (_) {
      return 'jpg';
    }
  }

  global.YTD_FILENAME = Object.freeze({
    sanitizeFilename,
    buildThumbnailFilename,
    extensionFromUrl
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
