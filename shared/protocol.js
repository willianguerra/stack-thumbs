/**
 * Contrato de mensagens compartilhado entre popup, content script e service worker.
 *
 * Carregado como script clássico nos três contextos:
 *   - content script  -> via manifest.content_scripts.js
 *   - popup           -> via <script src>
 *   - service worker  -> via importScripts()
 *
 * Por isso expõe tudo em globalThis em vez de usar `export`.
 */
(function attachProtocol(global) {
  'use strict';

  const PROTOCOL = Object.freeze({
    /** popup -> content script: verifica se o content script está vivo na aba. */
    PING: 'ytd:ping',
    /** popup -> content script: coleta os vídeos do DOM atual. */
    COLLECT: 'ytd:collect',
    /** popup -> service worker: dispara os downloads individuais. */
    DOWNLOAD: 'ytd:download',
    /** popup -> service worker: baixa tudo compactado num único .zip. */
    DOWNLOAD_ZIP: 'ytd:download-zip',
    /** service worker -> offscreen: busca as imagens e monta o ZIP. */
    ZIP_BUILD: 'ytd:zip-build',
    /** offscreen -> popup: progresso do download das imagens. */
    ZIP_PROGRESS: 'ytd:zip-progress',

    /**
     * Marca mensagens destinadas ao offscreen document. chrome.runtime.sendMessage
     * entrega para todos os contextos da extensão, então cada listener precisa
     * saber ignorar o que não é dele.
     */
    OFFSCREEN_TARGET: 'offscreen',

    /** Modo de captura: apenas cards ao menos parcialmente no viewport. */
    MODE_VISIBLE: 'visible',
    /** Modo de captura: todos os cards já carregados no DOM. */
    MODE_ALL: 'all',

    /** Chave usada em chrome.storage.local para lembrar o modo escolhido. */
    STORAGE_MODE_KEY: 'captureMode',
    /** Chave usada em chrome.storage.local para lembrar a preferência de ZIP. */
    STORAGE_ZIP_KEY: 'zipEnabled'
  });

  global.YTD_PROTOCOL = PROTOCOL;
})(typeof globalThis !== 'undefined' ? globalThis : self);
