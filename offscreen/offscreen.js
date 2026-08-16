/**
 * Offscreen document: busca as imagens, monta o ZIP e devolve uma blob URL.
 *
 * Por que existe: um service worker MV3 não tem URL.createObjectURL, e passar
 * megabytes de binário por chrome.runtime.sendMessage (que serializa em JSON)
 * seria inviável. Então quem busca e compacta é este documento — que, ao
 * contrário do popup, não morre quando o usuário clica fora.
 *
 * Offscreen documents só enxergam a API chrome.runtime; o download em si é
 * feito pelo service worker, a partir da URL devolvida aqui.
 */
(function initZipBuilder() {
  'use strict';

  const { ZIP_BUILD, ZIP_PROGRESS, OFFSCREEN_TARGET } = globalThis.YTD_PROTOCOL;
  const { buildThumbnailFilename, extensionFromUrl } = globalThis.YTD_FILENAME;
  const { createZip } = globalThis.YTD_ZIP;

  /** Downloads simultâneos das imagens. */
  const FETCH_CONCURRENCY = 4;
  /** Uma imagem que não responde não pode travar o ZIP inteiro. */
  const FETCH_TIMEOUT_MS = 15000;

  async function fetchImageBytes(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      // As imagens acabaram de ser carregadas pelo popup na verificação de
      // resolução, então normalmente saem do cache do browser.
      const response = await fetch(url, { signal: controller.signal, cache: 'force-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length) throw new Error('Resposta vazia');
      return bytes;
    } finally {
      clearTimeout(timer);
    }
  }

  function reportProgress(done, total) {
    chrome.runtime.sendMessage({ type: ZIP_PROGRESS, done, total }).catch(() => {
      // O popup pode ter sido fechado — o ZIP continua normalmente.
    });
  }

  /**
   * Busca todas as imagens preservando a ordem original.
   * @returns {Promise<Array<Uint8Array|null>>} null na posição que falhou
   */
  async function fetchAll(items) {
    const results = new Array(items.length).fill(null);
    let cursor = 0;
    let done = 0;

    const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        try {
          results[index] = await fetchImageBytes(items[index].url);
        } catch (_) {
          results[index] = null;
        }
        done += 1;
        reportProgress(done, items.length);
      }
    });

    await Promise.all(workers);
    return results;
  }

  async function buildZip(items) {
    const bytesList = await fetchAll(items);

    // Só os que baixaram entram, e a numeração fica contígua (01, 02, 03…)
    // mesmo que alguma imagem no meio tenha falhado.
    const succeeded = [];
    items.forEach((item, index) => {
      if (bytesList[index]) succeeded.push({ item, data: bytesList[index] });
    });

    const failed = items.length - succeeded.length;
    if (!succeeded.length) {
      return { ok: false, error: 'Nenhuma thumbnail pôde ser baixada.', failed };
    }

    const files = succeeded.map((entry, index) => ({
      name: buildThumbnailFilename({
        index: index + 1,
        total: succeeded.length,
        title: entry.item.title,
        videoId: entry.item.videoId,
        extension: extensionFromUrl(entry.item.url)
      }),
      data: entry.data
    }));

    const zipBytes = createZip(files);
    const blob = new Blob([zipBytes], { type: 'application/zip' });

    return {
      ok: true,
      url: URL.createObjectURL(blob),
      count: files.length,
      failed,
      bytes: zipBytes.length
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== OFFSCREEN_TARGET || message.type !== ZIP_BUILD) {
      return false;
    }

    buildZip(Array.isArray(message.items) ? message.items : [])
      .then(sendResponse)
      .catch((error) =>
        sendResponse({ ok: false, error: String((error && error.message) || error) })
      );

    return true;
  });
})();
