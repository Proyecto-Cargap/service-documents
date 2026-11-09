/** @file Generación acotada de miniaturas privadas, aislada de las solicitudes de Documents. */
'use strict';
const { Worker }           = require('node:worker_threads');
const path                 = require('node:path');
const { ApplicationError } = require('../../shared/application-error');
const waiting              = [];
let running                = 0;

/** Reserva como máximo dos decodificadores y limita la cola y su espera.
 * @returns {Promise<void>} Plaza disponible o error reintentable de capacidad.
 */
function acquire() {
  if (running < 2) {
    running++;
    return Promise.resolve();
  }
  if (waiting.length >= 32)
    return Promise.reject(new ApplicationError(503, 'ATTACHMENT_PREVIEW_UNAVAILABLE'));
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
            reject(new ApplicationError(503, 'ATTACHMENT_PREVIEW_UNAVAILABLE'));
          },
          10000,
        ),
      };
      waiting.push(entry);
    },
  );
}

/** Entrega la reserva al siguiente solicitante o libera el decodificador.
 * @returns {void} Cancela la espera del solicitante admitido.
 */
function release() {
  const next = waiting.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve();
  } else running--;
}

/** Genera WebP con entradas confinadas, plazo finito y sin ejecutar código de la imagen.
 * @param {string} filename Original previamente validado por Documents.
 * @param {string} destination Temporal privado reservado para la miniatura.
 * @returns {Promise<Object>} Dimensiones y bytes de la miniatura, nunca ubicaciones públicas.
 */
async function attachmentImage(filename, destination) {
  await acquire();
  try {
    return await new Promise(
      /**
       * Coordina la resolución o el rechazo de la operación asíncrona.
       * @param {Function} resolve Continuación que confirma el resultado de la promesa.
       * @param {Function} reject Continuación que rechaza la promesa con su causa.
       * @returns {void} Finaliza después de aplicar los efectos de la operación.
       */
      (resolve, reject) => {
        const worker = new Worker(
          path.join(__dirname, '../../modules/attachment/workers/attachment-image.worker.js'),
          {
            workerData     : {
              filename,
              destination,
            },
            resourceLimits : {
              maxOldGenerationSizeMb   : 64,
              maxYoungGenerationSizeMb : 16,
              stackSizeMb              : 4,
            },
          },
        );
        let settled  = false;
        /** Resuelve una sola vez y termina el trabajador antes de liberar sus temporales.
         * @param {Object} result Resultado técnico o error de procesamiento.
         * @returns {void} Finaliza el trabajador y entrega un resultado seguro.
         */
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          void worker.terminate().finally(
            /**
             * Libera o restablece los recursos al terminar la operación.
             * @returns {void} Finaliza después de aplicar los efectos de la operación.
             */
            () => {
              if (result?.width > 0 && result?.height > 0 && result?.size > 0) resolve(result);
              else
                reject(
                  new ApplicationError(result?.status || 422, 'ATTACHMENT_PREVIEW_UNAVAILABLE'),
                );
            },
          );
        };
        const timer  = setTimeout(
          /**
           * Ejecuta la continuación cuando vence el intervalo configurado.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          () => finish({ status: 503 }),
          10000,
        );
        worker.once('message', finish);
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
module.exports = { attachmentImage };
