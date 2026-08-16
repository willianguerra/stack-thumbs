/**
 * Popup: orquestra a detecção (content script), a resolução da melhor
 * thumbnail (aqui mesmo, via Image) e os downloads (service worker).
 *
 * Todo o texto vindo da página é inserido com textContent — nunca innerHTML.
 */
(function initPopup() {
  'use strict';

  const {
    PING,
    COLLECT,
    DOWNLOAD,
    DOWNLOAD_ZIP,
    ZIP_PROGRESS,
    MODE_VISIBLE,
    MODE_ALL,
    STORAGE_MODE_KEY,
    STORAGE_ZIP_KEY
  } = globalThis.YTD_PROTOCOL;
  const { THUMBNAIL_VARIANTS, buildThumbnailUrl, isRealThumbnail, isSupportedYouTubeUrl } =
    globalThis.YTD_YOUTUBE;

  /** Tempo máximo por tentativa de thumbnail. Sem isso a UI trava num request pendurado. */
  const PROBE_TIMEOUT_MS = 6000;
  /** Requisições simultâneas de verificação. */
  const PROBE_CONCURRENCY = 6;
  const TOAST_DURATION_MS = 2600;

  const dom = {
    brandVersion: document.getElementById('brandVersion'),
    statusBar: document.getElementById('status-bar'),
    pageContext: document.getElementById('page-context'),
    refreshButton: document.getElementById('refresh-button'),
    refreshFooter: document.getElementById('refresh-footer'),
    modeGroup: document.getElementById('mode-group'),
    stats: document.getElementById('stats'),
    toolbar: document.getElementById('toolbar'),
    selectAll: document.getElementById('select-all'),
    deselectAll: document.getElementById('deselect-all'),
    copySelected: document.getElementById('copy-selected'),
    zipRow: document.getElementById('zip-row'),
    zipToggle: document.getElementById('zip-toggle'),
    list: document.getElementById('list'),
    statePanel: document.getElementById('state-panel'),
    stateSpinner: document.getElementById('state-spinner'),
    stateTitle: document.getElementById('state-title'),
    stateHint: document.getElementById('state-hint'),
    downloadSelected: document.getElementById('download-selected'),
    toast: document.getElementById('toast'),
    itemTemplate: document.getElementById('item-template')
  };

  const state = {
    mode: MODE_VISIBLE,
    zipEnabled: true,
    videos: [],
    busy: false,
    resolving: null,
    /** {done,total} enquanto o ZIP é montado; null fora disso. */
    progress: null,
    /** Incrementa a cada detecção; verificações de detecções antigas param sozinhas. */
    generation: 0
  };

  /** videoId -> {url,width,height,label} | null (null = nenhuma variante válida). */
  const thumbnailCache = new Map();
  /** videoId -> elemento <li> renderizado. */
  const nodeByVideoId = new Map();

  let toastTimer = null;

  /* ------------------------------------------------------------------ *
   * Helpers de UI
   * ------------------------------------------------------------------ */

  function showToast(message, isError) {
    dom.toast.textContent = message;
    dom.toast.classList.toggle('is-error', Boolean(isError));
    dom.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      dom.toast.hidden = true;
    }, TOAST_DURATION_MS);
  }

  /** Cor do ponto da status bar: idle | running | success | warning | error. */
  function setStatus(kind) {
    dom.statusBar.className = `status-bar status-${kind}`;
  }

  function showState({ title, hint = '', spinner = false, isError = false }) {
    dom.list.hidden = true;
    dom.statePanel.hidden = false;
    dom.statePanel.classList.toggle('is-error', isError);
    dom.stateSpinner.hidden = !spinner;
    dom.stateTitle.textContent = title;
    dom.stateHint.textContent = hint;

    // Um painel sem spinner e sem erro é um "nada encontrado" — aviso, não falha.
    setStatus(spinner ? 'running' : isError ? 'error' : 'warning');
  }

  function showList() {
    dom.statePanel.hidden = true;
    dom.list.hidden = false;
    setStatus('success');
  }

  function setBusy(busy) {
    state.busy = busy;
    dom.refreshButton.disabled = busy;
    dom.refreshFooter.disabled = busy;
    dom.refreshButton.classList.toggle('is-spinning', busy);
    // Sem isso, trocar de modo durante a detecção seria ignorado em silêncio.
    dom.modeGroup.querySelectorAll('input').forEach((input) => {
      input.disabled = busy;
    });
    dom.zipToggle.disabled = busy;
    updateFooter();
  }

  /* ------------------------------------------------------------------ *
   * Contadores e seleção
   * ------------------------------------------------------------------ */

  const selectedVideos = () => state.videos.filter((video) => video.selected);
  const downloadableVideos = () => selectedVideos().filter((video) => Boolean(video.thumb));

  function updateStats() {
    const total = state.videos.length;
    if (!total) {
      dom.stats.textContent = 'Nenhum vídeo detectado.';
      dom.toolbar.hidden = true;
      dom.zipRow.hidden = true;
      return;
    }

    const resolved = state.videos.filter((video) => video.thumb).length;
    const pending = state.videos.filter((video) => video.status === 'pending').length;
    const selected = selectedVideos().length;

    const parts = [
      `${total} ${total === 1 ? 'vídeo detectado' : 'vídeos detectados'}`,
      pending
        ? `${resolved} de ${total} thumbnails verificadas`
        : `${resolved} ${resolved === 1 ? 'thumbnail encontrada' : 'thumbnails encontradas'}`,
      `${selected} ${selected === 1 ? 'selecionada' : 'selecionadas'}`
    ];

    dom.stats.textContent = parts.join(' · ');
    dom.toolbar.hidden = false;
    dom.zipRow.hidden = false;
  }

  /** Um único item vira .jpg direto — um ZIP com um arquivo só não ajuda ninguém. */
  function willUseZip(count) {
    return state.zipEnabled && count > 1;
  }

  function updateFooter() {
    const count = selectedVideos().length;

    if (state.progress) {
      const { done, total } = state.progress;
      dom.downloadSelected.textContent = `Compactando ${done}/${total}…`;
      dom.downloadSelected.disabled = true;
      dom.copySelected.disabled = true;
      return;
    }

    if (!count) {
      dom.downloadSelected.textContent = 'Baixar selecionadas';
    } else if (willUseZip(count)) {
      dom.downloadSelected.textContent = `Baixar .zip (${count})`;
    } else {
      dom.downloadSelected.textContent = `Baixar selecionadas (${count})`;
    }

    dom.downloadSelected.disabled = state.busy || count === 0;
    dom.copySelected.disabled = count === 0;
    dom.selectAll.disabled = count === state.videos.length;
    dom.deselectAll.disabled = count === 0;
  }

  function refreshCounters() {
    updateStats();
    updateFooter();
  }

  function setSelection(video, selected) {
    if (selected && !video.thumb && video.status === 'failed') return;
    video.selected = selected;
    const node = nodeByVideoId.get(video.videoId);
    if (node) {
      node.classList.toggle('is-selected', selected);
      const checkbox = node.querySelector('.item__checkbox');
      if (checkbox.checked !== selected) checkbox.checked = selected;
    }
    refreshCounters();
  }

  /* ------------------------------------------------------------------ *
   * Renderização
   * ------------------------------------------------------------------ */

  function renderList() {
    dom.list.textContent = '';
    nodeByVideoId.clear();

    const fragment = document.createDocumentFragment();
    state.videos.forEach((video) => {
      fragment.appendChild(createItemNode(video));
    });
    dom.list.appendChild(fragment);

    showList();
    refreshCounters();
  }

  function createItemNode(video) {
    const node = dom.itemTemplate.content.firstElementChild.cloneNode(true);
    const checkbox = node.querySelector('.item__checkbox');
    const image = node.querySelector('.item__image');

    node.dataset.videoId = video.videoId;
    node.classList.toggle('is-selected', video.selected);

    checkbox.checked = video.selected;
    checkbox.addEventListener('change', () => setSelection(video, checkbox.checked));

    node.querySelector('.item__position').textContent = String(video.position);
    node.querySelector('.item__title').textContent = video.title || video.videoId;
    node.querySelector('.item__title').title = video.title || video.videoId;

    // Preview instantâneo com a imagem que a página já carregou.
    image.src = video.pageThumbnailUrl || buildThumbnailUrl(video.videoId, 'mqdefault');
    image.alt = video.title || video.videoId;
    image.addEventListener('error', () => {
      image.removeAttribute('src');
    });

    node.querySelector('.item__download').addEventListener('click', () => downloadOne(video));
    node.querySelector('.item__copy').addEventListener('click', () => copyOne(video));

    nodeByVideoId.set(video.videoId, node);
    applyThumbnailToNode(video);
    return node;
  }

  function applyThumbnailToNode(video) {
    const node = nodeByVideoId.get(video.videoId);
    if (!node) return;

    const resolution = node.querySelector('.item__resolution');
    const badge = node.querySelector('.item__badge');
    const meta = node.querySelector('.item__meta');
    const downloadButton = node.querySelector('.item__download');
    const copyButton = node.querySelector('.item__copy');
    const checkbox = node.querySelector('.item__checkbox');
    const image = node.querySelector('.item__image');

    if (video.status === 'pending') {
      resolution.textContent = 'verificando…';
      badge.hidden = true;
      meta.classList.remove('is-error');
      downloadButton.disabled = true;
      copyButton.disabled = true;
      return;
    }

    if (video.thumb) {
      resolution.textContent = `${video.thumb.width} × ${video.thumb.height}`;
      badge.textContent = video.thumb.label;
      badge.hidden = false;
      meta.classList.remove('is-error');
      node.classList.remove('is-unavailable');
      downloadButton.disabled = false;
      copyButton.disabled = false;
      checkbox.disabled = false;
      if (image.src !== video.thumb.url) image.src = video.thumb.url;
      return;
    }

    resolution.textContent = 'thumbnail indisponível';
    badge.hidden = true;
    meta.classList.add('is-error');
    node.classList.add('is-unavailable');
    downloadButton.disabled = true;
    copyButton.disabled = true;
    checkbox.disabled = true;
    checkbox.checked = false;
    node.classList.remove('is-selected');
  }

  /* ------------------------------------------------------------------ *
   * Resolução da melhor thumbnail
   * ------------------------------------------------------------------ */

  /** Carrega uma imagem e devolve suas dimensões reais, ou null (erro/timeout). */
  function loadImageSize(url, timeoutMs) {
    return new Promise((resolve) => {
      const image = new Image();
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        image.onload = null;
        image.onerror = null;
        resolve(result);
      };

      const timer = setTimeout(() => finish(null), timeoutMs);

      image.onload = () => finish({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => finish(null);
      image.referrerPolicy = 'no-referrer';
      image.decoding = 'async';
      image.src = url;
    });
  }

  /**
   * maxres -> sd -> hq -> mq, parando na primeira variante que realmente existe.
   * Dimensões abaixo do esperado indicam o placeholder do YouTube, não a imagem.
   */
  async function resolveBestThumbnail(videoId) {
    if (thumbnailCache.has(videoId)) return thumbnailCache.get(videoId);

    for (const variant of THUMBNAIL_VARIANTS) {
      const url = buildThumbnailUrl(videoId, variant.key);
      if (!url) break;

      const size = await loadImageSize(url, PROBE_TIMEOUT_MS);
      if (size && isRealThumbnail(variant, size.width, size.height)) {
        const thumb = { url, width: size.width, height: size.height, label: variant.label };
        thumbnailCache.set(videoId, thumb);
        return thumb;
      }
    }

    thumbnailCache.set(videoId, null);
    return null;
  }

  /** Executa `worker` sobre `items` com paralelismo limitado. */
  async function runWithConcurrency(items, limit, worker) {
    let cursor = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await worker(items[index]);
      }
    });
    await Promise.all(runners);
  }

  function resolveAllThumbnails(videos) {
    const generation = state.generation;

    const task = runWithConcurrency(videos, PROBE_CONCURRENCY, async (video) => {
      // Uma nova detecção começou: não faz sentido continuar verificando a antiga.
      if (state.generation !== generation) return;

      video.thumb = await resolveBestThumbnail(video.videoId);
      video.status = video.thumb ? 'ok' : 'failed';
      if (!video.thumb) video.selected = false;

      if (state.generation !== generation) return;
      applyThumbnailToNode(video);
      refreshCounters();
    });

    state.resolving = task;
    task.finally(() => {
      if (state.resolving === task) state.resolving = null;
      refreshCounters();
    });
    return task;
  }

  /* ------------------------------------------------------------------ *
   * Detecção
   * ------------------------------------------------------------------ */

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  }

  async function pingContentScript(tabId) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: PING });
      return Boolean(response && response.ok);
    } catch (_) {
      return false;
    }
  }

  /**
   * Garante que o content script esteja presente. A declaração no manifest
   * cobre o caso normal; a injeção cobre abas que já estavam abertas quando a
   * extensão foi instalada ou recarregada.
   */
  async function ensureContentScript(tabId) {
    if (await pingContentScript(tabId)) return true;

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['shared/protocol.js', 'shared/youtube.js', 'content/content.js']
      });
    } catch (_) {
      return false;
    }

    return pingContentScript(tabId);
  }

  async function detect() {
    if (state.busy) return;
    setBusy(true);

    state.generation += 1;
    state.resolving = null;
    state.videos = [];
    nodeByVideoId.clear();
    dom.list.textContent = '';
    dom.toolbar.hidden = true;
    dom.stats.textContent = 'Detectando vídeos…';
    showState({ title: 'Detectando vídeos…', spinner: true });

    try {
      const tab = await getActiveTab();

      if (!tab || !isSupportedYouTubeUrl(tab.url)) {
        dom.pageContext.textContent = 'Nenhuma aba do YouTube ativa';
        showState({
          title: 'Abra uma página do YouTube para utilizar a extensão.',
          hint: 'Funciona na home, canais, /videos, resultados de busca, playlists, inscrições e vídeos relacionados.'
        });
        return;
      }

      dom.pageContext.textContent = describePage(tab.url);

      const ready = await ensureContentScript(tab.id);
      if (!ready) {
        showState({
          title: 'Não foi possível ler esta página.',
          hint: 'Recarregue a aba do YouTube (F5) e abra a extensão novamente.',
          isError: true
        });
        return;
      }

      const response = await chrome.tabs.sendMessage(tab.id, {
        type: COLLECT,
        mode: state.mode
      });

      if (!response || !response.ok) {
        showState({
          title: 'Falha ao analisar a página.',
          hint: (response && response.error) || 'Tente atualizar a lista.',
          isError: true
        });
        return;
      }

      state.videos = response.videos.map((video) => ({
        ...video,
        selected: true,
        status: 'pending',
        thumb: null
      }));

      if (!state.videos.length) {
        dom.stats.textContent = 'Nenhum vídeo detectado.';
        showState({
          title:
            state.mode === MODE_VISIBLE
              ? 'Nenhum vídeo encontrado na área visível.'
              : 'Nenhum vídeo encontrado nesta página.',
          hint:
            state.mode === MODE_VISIBLE
              ? 'Role a página até os vídeos aparecerem, ou troque para “Todos carregados”.'
              : 'Abra uma página com listagem de vídeos e atualize.'
        });
        return;
      }

      renderList();
      resolveAllThumbnails(state.videos);
    } catch (error) {
      showState({
        title: 'Erro inesperado ao detectar vídeos.',
        hint: String((error && error.message) || error),
        isError: true
      });
    } finally {
      setBusy(false);
    }
  }

  function describePage(url) {
    try {
      const { pathname, searchParams } = new URL(url);
      if (pathname === '/') return 'Página inicial do YouTube';
      if (pathname.startsWith('/results')) {
        const query = searchParams.get('search_query');
        return query ? `Busca: ${query}` : 'Resultados de pesquisa';
      }
      if (pathname.startsWith('/feed/subscriptions')) return 'Inscrições';
      if (pathname.startsWith('/feed/')) return `Feed: ${pathname.replace('/feed/', '')}`;
      if (pathname.startsWith('/playlist')) return 'Playlist';
      if (pathname.startsWith('/watch')) return 'Página de vídeo';
      if (pathname.startsWith('/shorts')) return 'Shorts';
      return `youtube.com${pathname}`;
    } catch (_) {
      return 'YouTube';
    }
  }

  /* ------------------------------------------------------------------ *
   * Downloads e cópia
   * ------------------------------------------------------------------ */

  async function sendDownloads(videos, asZip) {
    const items = videos.map((video) => ({
      url: video.thumb.url,
      title: video.title,
      videoId: video.videoId
    }));

    const response = await chrome.runtime.sendMessage({
      type: asZip ? DOWNLOAD_ZIP : DOWNLOAD,
      items
    });

    if (!response || !response.ok) {
      throw new Error((response && response.error) || 'Falha ao iniciar os downloads.');
    }
    return response;
  }

  /** O botão de cada item sempre baixa o .jpg direto, nunca um ZIP. */
  async function downloadOne(video) {
    if (!video.thumb) return;
    try {
      await sendDownloads([video], false);
      showToast('Download iniciado.');
    } catch (error) {
      showToast(String(error.message || error), true);
    }
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    const mega = bytes / (1024 * 1024);
    return mega >= 1 ? `${mega.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
  }

  async function downloadAllSelected() {
    if (state.busy) return;

    if (state.resolving) {
      showToast('Aguardando a verificação das thumbnails…');
      await state.resolving;
    }

    const videos = downloadableVideos();
    if (!videos.length) {
      showToast('Nenhuma thumbnail disponível para download.', true);
      return;
    }

    const asZip = willUseZip(videos.length);
    setBusy(true);
    if (asZip) {
      state.progress = { done: 0, total: videos.length };
      updateFooter();
    }

    try {
      const response = await sendDownloads(videos, asZip);
      const failed = response.failed || 0;

      if (response.zip) {
        const size = formatBytes(response.bytes);
        showToast(
          failed
            ? `ZIP com ${response.started} thumbnails — ${failed} não entrou(aram).`
            : `ZIP com ${response.started} thumbnails${size ? ` (${size})` : ''} baixado.`,
          Boolean(failed)
        );
      } else {
        showToast(
          failed
            ? `${response.started} download(s) iniciado(s), ${failed} falhou(aram).`
            : `${response.started} download(s) iniciado(s).`,
          Boolean(failed)
        );
      }
    } catch (error) {
      showToast(String(error.message || error), true);
    } finally {
      state.progress = null;
      setBusy(false);
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      // Fallback para quando a Clipboard API não está disponível no popup.
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      let copied = false;
      try {
        copied = document.execCommand('copy');
      } catch (__) {
        copied = false;
      }
      document.body.removeChild(area);
      return copied;
    }
  }

  function bestUrlFor(video) {
    return (video.thumb && video.thumb.url) || buildThumbnailUrl(video.videoId, 'maxresdefault');
  }

  async function copyOne(video) {
    const ok = await copyText(bestUrlFor(video));
    showToast(ok ? 'URL copiada.' : 'Não foi possível copiar.', !ok);
  }

  async function copyAllSelected() {
    const videos = selectedVideos();
    if (!videos.length) return;
    const text = videos.map(bestUrlFor).join('\n');
    const ok = await copyText(text);
    showToast(ok ? `${videos.length} URL(s) copiada(s).` : 'Não foi possível copiar.', !ok);
  }

  /* ------------------------------------------------------------------ *
   * Bootstrap
   * ------------------------------------------------------------------ */

  async function loadStoredPreferences() {
    try {
      const stored = await chrome.storage.local.get([STORAGE_MODE_KEY, STORAGE_ZIP_KEY]);
      const mode = stored && stored[STORAGE_MODE_KEY];
      if (mode === MODE_ALL || mode === MODE_VISIBLE) state.mode = mode;
      if (stored && typeof stored[STORAGE_ZIP_KEY] === 'boolean') {
        state.zipEnabled = stored[STORAGE_ZIP_KEY];
      }
    } catch (_) {
      /* mantém os padrões */
    }

    const input = dom.modeGroup.querySelector(`input[value="${state.mode}"]`);
    if (input) input.checked = true;
    dom.zipToggle.checked = state.zipEnabled;
  }

  function bindEvents() {
    dom.refreshButton.addEventListener('click', detect);
    dom.refreshFooter.addEventListener('click', detect);
    dom.downloadSelected.addEventListener('click', downloadAllSelected);
    dom.copySelected.addEventListener('click', copyAllSelected);

    dom.selectAll.addEventListener('click', () => {
      state.videos.forEach((video) => setSelection(video, Boolean(video.thumb) || video.status === 'pending'));
    });

    dom.deselectAll.addEventListener('click', () => {
      state.videos.forEach((video) => setSelection(video, false));
    });

    dom.modeGroup.addEventListener('change', (event) => {
      const value = event.target && event.target.value;
      if (value !== MODE_VISIBLE && value !== MODE_ALL) return;
      state.mode = value;
      chrome.storage.local.set({ [STORAGE_MODE_KEY]: value }).catch(() => {});
      detect();
    });

    dom.zipToggle.addEventListener('change', () => {
      state.zipEnabled = dom.zipToggle.checked;
      chrome.storage.local.set({ [STORAGE_ZIP_KEY]: state.zipEnabled }).catch(() => {});
      updateFooter();
    });

    // Progresso enviado pelo offscreen document enquanto monta o ZIP.
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || message.type !== ZIP_PROGRESS || !state.progress) return false;
      state.progress = { done: message.done, total: message.total };
      updateFooter();
      return false;
    });
  }

  async function start() {
    dom.brandVersion.textContent = `v${chrome.runtime.getManifest().version}`;
    bindEvents();
    await loadStoredPreferences();
    await detect();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
