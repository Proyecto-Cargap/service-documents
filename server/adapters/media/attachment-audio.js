/** @file Acreditación acotada de audio mediante pistas reales, aislada del proceso de solicitudes. */
'use strict';
const { Worker }           = require('node:worker_threads');
const path                 = require('node:path');
const { ApplicationError } = require('../../shared/application-error');
const LIMIT                = 2;
const MAX_WAITERS          = 32;
const DEADLINE_MS          = 5000;
let running                = 0;
const waiting              = [];

/**
 * Reserva un analizador sin crear trabajadores ilimitados bajo cargas simultáneas.
 * @returns {Promise<void>} Reserva del trabajador; la sobrecarga puede reintentarse sin escribir datos.
 */
function acquire() {
  if (running < LIMIT) {
    running++;
    return Promise.resolve();
  }
  if (waiting.length >= MAX_WAITERS)
    return Promise.reject(new ApplicationError(503, 'ATTACHMENT_STORAGE_UNAVAILABLE'));
  return new Promise(
    /**
     * Coordina la resolución o el rechazo de la operación asíncrona.
     * @param {Function} resolve Continuación que confirma el resultado de la promesa.
     * @param {Function} reject Continuación que rechaza la promesa con su causa.
     * @returns {void} Finaliza después de aplicar los efectos de la operación.
     */
    (resolve, reject) => {
      const entry = {
        resolve,
        timer : setTimeout(
          /**
           * Ejecuta la continuación cuando vence el intervalo configurado.
           * @returns {void} Finaliza después de aplicar los efectos de la operación.
           */
          () => {
            const index = waiting.indexOf(entry);
            if (index >= 0) waiting.splice(index, 1);
            reject(new ApplicationError(503, 'ATTACHMENT_STORAGE_UNAVAILABLE'));
          },
          DEADLINE_MS,
        ),
      };
      waiting.push(entry);
    },
  );
}

/**
 * Entrega la plaza al siguiente solicitante o reduce el total de analizadores activos.
 * @returns {void} Cancela el plazo del solicitante que recibió la reserva.
 */
function release() {
  const next = waiting.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve();
  } else running--;
}

/**
 * Inspecciona un temporal previamente confinado, sin confiar en nombre ni MIME del cliente.
 * @param {string} filename Temporal validado por el almacén de Communication.
 * @returns {Promise<string>} MIME de audio acreditado o binario si es ambiguo, inválido o excede el análisis.
 */
async function attachmentAudio(filename) {
  await acquire();
  try {
    return await new Promise(
      /**
       * Coordina la resolución o el rechazo de la operación asíncrona.
       * @param {Function} resolve Continuación que confirma el resultado de la promesa.
       * @returns {void} Finaliza después de aplicar los efectos de la operación.
       */
      (resolve) => {
        const worker = new Worker(
          path.join(__dirname, '../../modules/attachment/workers/attachment-audio.worker.js'),
          {
            workerData     : { filename },
            resourceLimits : {
              maxOldGenerationSizeMb   : 64,
              maxYoungGenerationSizeMb : 16,
              stackSizeMb              : 4,
            },
          },
        );
        let settled  = false;
        /**
         * Cierra el trabajador y confirma una sola clasificación permitida.
         * @param {string} mime Clasificación calculada o resultado seguro por defecto.
         * @returns {void} Resuelve después de liberar el trabajador y sus archivos abiertos.
         */
        const finish = (mime = 'application/octet-stream') => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          void worker.terminate().finally(
            /**
             * Libera o restablece los recursos al terminar la operación.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            () =>
              resolve(
                ['audio/webm', 'audio/mp4', 'audio/ogg'].includes(mime)
                  ? mime
                  : 'application/octet-stream',
              ),
          );
        };
        const timer  = setTimeout(
          /**
           * Ejecuta la continuación cuando vence el intervalo configurado.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          () => finish(),
          DEADLINE_MS,
        );
        worker.once(
          'message',

          /**
           * Atiende una sola emisión del evento esperado.
           * @param {*} result Valor de result utilizado por esta operación.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          (result) => finish(result),
        );
        worker.once(
          'error',

          /**
           * Atiende una sola emisión del evento esperado.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          () => finish(),
        );
        worker.once(
          'exit',

          /**
           * Atiende una sola emisión del evento esperado.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          () => finish(),
        );
      },
    );
  } finally {
    release();
  }
}
module.exports = { attachmentAudio };
