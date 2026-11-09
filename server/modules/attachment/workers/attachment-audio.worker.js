/** @file Inspección de contenedores de notas de voz en un trabajador con memoria y tiempo limitados. */
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { open }                   = require('node:fs/promises');

/**
 * Deriva el MIME del contenedor y acredita audio compatible sin pistas de video o desconocidas.
 * @returns {Promise<string>} Audio reproducible o binario; nunca confía en extensiones suministradas.
 */
async function inspect() {
  const { parseFile } = await import('music-metadata');
  const { format }    = await parseFile(workerData.filename, {
    skipCovers          : true,
    maxMemoryAllocation : 4 * 1024 * 1024,
  });
  const tracks        = format.trackInfo || [];
  if (
    !tracks.length ||
    format.hasVideo ||
    tracks.some(
      /**
       * Comprueba si el elemento satisface la condición.
       * @param {*} track Valor de track utilizado por esta operación.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (track) => track.type !== 2,
    )
  )
    return 'application/octet-stream';
  const compatible = tracks.some(
    /**
     * Comprueba si el elemento satisface la condición.
     * @param {*} track Valor de track utilizado por esta operación.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    (track) => {
      const codec = String(track.codecId || track.codecName || format.codec || '').toLowerCase();
      return codec.includes('opus') || codec.includes('aac') || codec === 'mp4a';
    },
  );
  if (!compatible) return 'application/octet-stream';
  const container = String(format.container || '').toLowerCase();
  if (container === 'ebml/webm') return 'audio/webm';
  const handle = await open(workerData.filename, 'r');
  try {
    const signature = Buffer.alloc(12);
    await handle.read(signature, 0, 12, 0);
    if (signature.toString('ascii', 4, 8) === 'ftyp') return 'audio/mp4';
  } finally {
    await handle.close();
  }
  if (container === 'ogg') return 'audio/ogg';
  return 'application/octet-stream';
}
if (parentPort && workerData)
  void inspect()
    .then(
      /**
       * Procesa el resultado de la operación asíncrona.
       * @param {*} mime Valor de mime utilizado por esta operación.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (mime) => parentPort.postMessage(mime),
    )
    .catch(
      /**
       * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      () => parentPort.postMessage('application/octet-stream'),
    );
