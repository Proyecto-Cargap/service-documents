/** @file Generación y lectura técnica de QR; no decide almacenamiento, permisos ni respuestas públicas. */
'use strict';
/** Compone el procesamiento QR con generador, lector y decodificador de imágenes sustituibles.
 * @param {Object} sdk Constructores QRCodeCanvas, QrReader e implementación Jimp.
 * @returns {Object} Escritura PNG y lectura de contenido; no devuelve objetos del SDK.
 */
function qrProcessor({ QRCodeCanvas, QrReader, Jimp: imageDecoder }) {
  return {
    /** Escribe el QR configurado en un destino previamente acreditado.
     * @param {Object} options Configuración de contenido, estilo y dimensiones.
     * @param {string} destination Temporal privado de salida.
     * @returns {Promise<void>} Confirma la escritura o propaga su fallo.
     */
    async write(options, destination) {
      await new QRCodeCanvas(options).toFile(destination, 'png');
    },
    /** Decodifica una imagen sin conservar el lector ni su bitmap en el dominio.
     * @param {Buffer} buffer Bytes de una imagen ya autorizada.
     * @returns {Promise<string|null>} Contenido identificado o null cuando no se obtuvo imagen.
     * @throws {Error} QR_INVALID_IMAGE o QR_NOT_FOUND para traducirlos en la frontera de aplicación.
     */
    async read(buffer) {
      let image;
      try {
        image = await imageDecoder.read(buffer);
      } catch (cause) {
        throw Object.assign(new Error('QR_INVALID_IMAGE'), {
          code : 'QR_INVALID_IMAGE',
          cause,
        });
      }
      if (!image) return null;
      return new Promise(
        /**
         * Aplica la operación local y devuelve su resultado al flujo que la invoca.
         * @param {*} resolve Valor utilizado por la operación.
         * @param {*} reject Valor utilizado por la operación.
         * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
         */
        (resolve, reject) => {
          const reader = new QrReader();

          /**
           * Aplica la operación local y devuelve su resultado al flujo que la invoca.
           * @param {*} cause Valor utilizado por la operación.
           * @param {*} value Valor utilizado por la operación.
           * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
           */
          reader.callback = (cause, value) => {
            if (cause)
              reject(
                Object.assign(new Error('QR_NOT_FOUND'), {
                  code : 'QR_NOT_FOUND',
                  cause,
                }),
              );
            else resolve(value.result);
          };
          reader.decode(image.bitmap);
        },
      );
    },
  };
}
module.exports = { qrProcessor };
