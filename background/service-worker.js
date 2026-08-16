/**
 * Service worker (MV3): único ponto que fala com chrome.downloads.
 *
 * O popup pode fechar a qualquer momento (basta o usuário clicar fora), então
 * os downloads precisam ser disparados aqui — o worker sobrevive ao popup.
 */
importScripts('/shared/protocol.js', '/shared/filename.js', '/shared/zip.js');

const { DOWNLOAD, DOWNLOAD_ZIP, ZIP_BUILD, OFFSCREEN_TARGET } = globalThis.YTD_PROTOCOL;
const { buildThumbnailFilename, extensionFromUrl } = globalThis.YTD_FILENAME;
const { buildZipFilename } = globalThis.YTD_ZIP;

/** Subpasta dentro de Downloads, para não espalhar arquivos soltos. */
const DOWNLOAD_FOLDER = 'YouTube Thumbnails';

/** Intervalo entre downloads: evita que o Chrome estrangule uma rajada grande. */
const DOWNLOAD_INTERVAL_MS = 120;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Só aceitamos URLs de thumbnail do próprio YouTube. */
function isAllowedThumbnailUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'https:') return false;
    const host = hostname.toLowerCase();
    return (
      host === 'i.ytimg.com' ||
      host === 'img.youtube.com' ||
      host === 'i9.ytimg.com' ||
      host.endsWith('.ggpht.com')
    );
  } catch (_) {
    return false;
  }
}

/**
 * Dispara os downloads em sequência, tolerando falhas individuais.
 * @param {Array<{url:string,title?:string,videoId?:string}>} items
 */
async function downloadThumbnails(items) {
  const results = [];
  const total = items.length;

  for (let i = 0; i < total; i += 1) {
    const item = items[i] || {};
    const index = i + 1;

    if (!isAllowedThumbnailUrl(item.url)) {
      results.push({ videoId: item.videoId, ok: false, error: 'URL de thumbnail inválida' });
      continue;
    }

    const filename = `${DOWNLOAD_FOLDER}/${buildThumbnailFilename({
      index,
      total,
      title: item.title,
      videoId: item.videoId,
      extension: extensionFromUrl(item.url)
    })}`;

    try {
      const downloadId = await chrome.downloads.download({
        url: item.url,
        filename,
        conflictAction: 'uniquify',
        saveAs: false
      });
      results.push({ videoId: item.videoId, ok: true, downloadId, filename });
    } catch (error) {
      results.push({
        videoId: item.videoId,
        ok: false,
        error: String((error && error.message) || error)
      });
    }

    if (index < total) await delay(DOWNLOAD_INTERVAL_MS);
  }

  return {
    ok: true,
    started: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results
  };
}

/* ------------------------------------------------------------------ *
 * Download em ZIP
 * ------------------------------------------------------------------ */

const OFFSCREEN_URL = 'offscreen/offscreen.html';
/** Tempo máximo esperando o download do ZIP terminar antes de liberar o offscreen. */
const ZIP_DOWNLOAD_TIMEOUT_MS = 120000;

/** Evita duas criações simultâneas do offscreen document. */
let offscreenCreation = null;

async function hasOffscreenDocument() {
  // getContexts existe a partir do Chrome 116; antes disso caímos no try/catch.
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) {
    throw new Error('Seu navegador não suporta o download em ZIP. Atualize-o.');
  }
  if (await hasOffscreenDocument()) return;

  if (!offscreenCreation) {
    offscreenCreation = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['BLOBS'],
        justification: 'Montar o arquivo ZIP das thumbnails e gerar a URL de download.'
      })
      .catch((error) => {
        // Corrida com outra criação: o documento já existe, o que serve.
        if (!/single offscreen document/i.test(String(error && error.message))) throw error;
      })
      .finally(() => {
        offscreenCreation = null;
      });
  }

  await offscreenCreation;
}

async function closeOffscreenDocument() {
  try {
    if (chrome.offscreen && (await hasOffscreenDocument())) {
      // Fechar o documento revoga as blob URLs que ele criou.
      await chrome.offscreen.closeDocument();
    }
  } catch (_) {
    /* nada a fazer */
  }
}

/** Espera o download terminar — fechar o offscreen antes disso o interromperia. */
function waitForDownload(downloadId) {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (state) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(state);
    };

    const onChanged = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
        finish(delta.state.current);
      }
    };

    const timer = setTimeout(() => finish('timeout'), ZIP_DOWNLOAD_TIMEOUT_MS);
    chrome.downloads.onChanged.addListener(onChanged);

    // O download pode ter terminado antes do listener entrar.
    chrome.downloads
      .search({ id: downloadId })
      .then((results) => {
        const item = results && results[0];
        if (item && (item.state === 'complete' || item.state === 'interrupted')) {
          finish(item.state);
        }
      })
      .catch(() => {});
  });
}

async function downloadAsZip(items) {
  const valid = items.filter((item) => isAllowedThumbnailUrl(item && item.url));
  if (!valid.length) {
    return { ok: false, error: 'Nenhuma thumbnail válida para compactar.' };
  }

  await ensureOffscreenDocument();

  try {
    const built = await chrome.runtime.sendMessage({
      type: ZIP_BUILD,
      target: OFFSCREEN_TARGET,
      items: valid
    });

    if (!built || !built.ok) {
      return { ok: false, error: (built && built.error) || 'Falha ao montar o ZIP.' };
    }

    const filename = buildZipFilename();
    const downloadId = await chrome.downloads.download({
      url: built.url,
      filename,
      conflictAction: 'uniquify',
      saveAs: false
    });

    const finalState = await waitForDownload(downloadId);
    if (finalState === 'interrupted') {
      return { ok: false, error: 'O download do ZIP foi interrompido.' };
    }

    return {
      ok: true,
      zip: true,
      filename,
      started: built.count,
      failed: built.failed + (items.length - valid.length),
      bytes: built.bytes
    };
  } finally {
    await closeOffscreenDocument();
  }
}

/* ------------------------------------------------------------------ *
 * Roteamento de mensagens
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target === OFFSCREEN_TARGET) return false;
  if (message.type !== DOWNLOAD && message.type !== DOWNLOAD_ZIP) return false;

  const items = Array.isArray(message.items) ? message.items : [];
  if (!items.length) {
    sendResponse({ ok: false, error: 'Nenhuma thumbnail selecionada.' });
    return false;
  }

  const task = message.type === DOWNLOAD_ZIP ? downloadAsZip(items) : downloadThumbnails(items);

  task
    .then(sendResponse)
    .catch((error) =>
      sendResponse({ ok: false, error: String((error && error.message) || error) })
    );

  // Resposta assíncrona.
  return true;
});
