/**
 * Gerador de arquivos ZIP sem dependências externas.
 *
 * Usa o método "store" (sem compressão): as thumbnails já são JPEG, que é um
 * formato comprimido — passar deflate nelas gastaria CPU para ganhar ~0%.
 * O resultado é um ZIP padrão, que abre no Explorer do Windows, no macOS e em
 * qualquer ferramenta comum.
 *
 * Script clássico compartilhado (ver shared/protocol.js para o motivo).
 */
(function attachZipBuilder(global) {
  'use strict';

  const LOCAL_HEADER_SIG = 0x04034b50;
  const CENTRAL_HEADER_SIG = 0x02014b50;
  const END_OF_CENTRAL_SIG = 0x06054b50;

  /** Marca os nomes como UTF-8 (bit 11), para acentos não virarem lixo. */
  const FLAG_UTF8 = 0x0800;
  const METHOD_STORE = 0;
  const VERSION_NEEDED = 20;

  /** Limites do ZIP clássico. Acima disso seria necessário ZIP64. */
  const MAX_ENTRIES = 0xffff;
  const MAX_TOTAL_BYTES = 0xffffffff;

  let crcTable = null;

  function getCrcTable() {
    if (crcTable) return crcTable;
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let value = i;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[i] = value >>> 0;
    }
    return crcTable;
  }

  /** CRC-32 (polinômio IEEE 802.3), exigido pelo formato ZIP. */
  function crc32(bytes) {
    const table = getCrcTable();
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
      crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  /** Converte uma Date para o par (hora, data) no formato MS-DOS do ZIP. */
  function toDosDateTime(date) {
    const year = Math.max(1980, date.getFullYear());
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
  }

  /** Escritor sequencial little-endian. */
  function createWriter(size) {
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    let offset = 0;
    return {
      bytes,
      get offset() {
        return offset;
      },
      u16(value) {
        view.setUint16(offset, value, true);
        offset += 2;
      },
      u32(value) {
        view.setUint32(offset, value >>> 0, true);
        offset += 4;
      },
      raw(chunk) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
    };
  }

  /**
   * Monta um ZIP a partir de uma lista de arquivos.
   *
   * @param {Array<{name:string, data:Uint8Array}>} files
   * @param {Date} [modifiedAt]
   * @returns {Uint8Array}
   */
  function createZip(files, modifiedAt) {
    if (!Array.isArray(files) || !files.length) {
      throw new Error('Nenhum arquivo para compactar.');
    }
    if (files.length > MAX_ENTRIES) {
      throw new Error(`Máximo de ${MAX_ENTRIES} arquivos por ZIP.`);
    }

    const encoder = new TextEncoder();
    const stamp = toDosDateTime(modifiedAt instanceof Date ? modifiedAt : new Date());

    const entries = files.map((file) => {
      const nameBytes = encoder.encode(String(file.name));
      const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
      return { nameBytes, data, crc: crc32(data), offset: 0 };
    });

    const localSize = entries.reduce(
      (sum, entry) => sum + 30 + entry.nameBytes.length + entry.data.length,
      0
    );
    const centralSize = entries.reduce((sum, entry) => sum + 46 + entry.nameBytes.length, 0);
    const totalSize = localSize + centralSize + 22;

    if (totalSize > MAX_TOTAL_BYTES) {
      throw new Error('O ZIP ficaria grande demais (limite de 4 GB).');
    }

    const writer = createWriter(totalSize);

    // 1) Cabeçalho local + dados de cada arquivo.
    for (const entry of entries) {
      entry.offset = writer.offset;
      writer.u32(LOCAL_HEADER_SIG);
      writer.u16(VERSION_NEEDED);
      writer.u16(FLAG_UTF8);
      writer.u16(METHOD_STORE);
      writer.u16(stamp.time);
      writer.u16(stamp.date);
      writer.u32(entry.crc);
      writer.u32(entry.data.length); // tamanho comprimido == original (store)
      writer.u32(entry.data.length);
      writer.u16(entry.nameBytes.length);
      writer.u16(0); // sem campo extra
      writer.raw(entry.nameBytes);
      writer.raw(entry.data);
    }

    // 2) Diretório central.
    const centralOffset = writer.offset;
    for (const entry of entries) {
      writer.u32(CENTRAL_HEADER_SIG);
      writer.u16(VERSION_NEEDED); // versão que criou
      writer.u16(VERSION_NEEDED); // versão necessária
      writer.u16(FLAG_UTF8);
      writer.u16(METHOD_STORE);
      writer.u16(stamp.time);
      writer.u16(stamp.date);
      writer.u32(entry.crc);
      writer.u32(entry.data.length);
      writer.u32(entry.data.length);
      writer.u16(entry.nameBytes.length);
      writer.u16(0); // extra
      writer.u16(0); // comentário
      writer.u16(0); // disco inicial
      writer.u16(0); // atributos internos
      writer.u32(0); // atributos externos
      writer.u32(entry.offset);
      writer.raw(entry.nameBytes);
    }

    // 3) Fim do diretório central.
    writer.u32(END_OF_CENTRAL_SIG);
    writer.u16(0); // número do disco
    writer.u16(0); // disco do diretório central
    writer.u16(entries.length);
    writer.u16(entries.length);
    writer.u32(writer.offset - centralOffset);
    writer.u32(centralOffset);
    writer.u16(0); // comentário

    return writer.bytes;
  }

  /** Nome do ZIP com data/hora local: youtube-thumbnails-2026-08-16_14-32.zip */
  function buildZipFilename(date) {
    const now = date instanceof Date ? date : new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return [
      'youtube-thumbnails-',
      now.getFullYear(),
      '-',
      pad(now.getMonth() + 1),
      '-',
      pad(now.getDate()),
      '_',
      pad(now.getHours()),
      '-',
      pad(now.getMinutes()),
      '.zip'
    ].join('');
  }

  global.YTD_ZIP = Object.freeze({ crc32, createZip, buildZipFilename });
})(typeof globalThis !== 'undefined' ? globalThis : self);
