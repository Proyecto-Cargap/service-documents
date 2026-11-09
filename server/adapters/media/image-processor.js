/** @file Procesamiento de imágenes sustituible; encapsula las cadenas y resultados técnicos de Sharp. */
'use strict';
/** Conecta las operaciones de imágenes con el procesador recibido.
 * @param {Function} sharp Implementación técnica que abre y transforma imágenes.
 * @returns {Object} Metadatos acotados y generación de variantes, sin instancias del SDK.
 */
function imageProcessor(sharp) {
  return {
    /** Obtiene únicamente los metadatos que necesita el almacenamiento.
     * @param {string} filename Temporal previamente confinado.
     * @returns {Promise<Object>} Formato y dimensiones de la imagen acreditada.
     */
    async metadata(filename) {
      const { format, width, height } = await sharp(filename, {
        limitInputPixels : 40000000,
      }).metadata();
      return {
        format,
        width,
        height,
      };
    },
    /** Genera una miniatura con la política histórica de ancho y formato del archivo.
     * @param {string} source Temporal original previamente validado.
     * @param {number} width Ancho solicitado por el dominio.
     * @param {string} destination Temporal de salida previamente validado.
     * @returns {Promise<void>} Confirma que la variante se escribió completamente.
     */
    async resizeFile(source, width, destination) {
      await sharp(source).resize({ width }).toFile(destination);
    },
    /** Genera una variante PNG orientada sin ampliar el original.
     * @param {string} filename Temporal original previamente validado.
     * @param {number} width Ancho máximo de la variante.
     * @returns {Promise<Object>} Bytes y dimensiones simples, sin metadatos adicionales del SDK.
     */
    async variantPng(filename, width) {
      const { data, info } = await sharp(filename, { limitInputPixels: 40000000 })
        .rotate()
        .resize({
          width,
          withoutEnlargement : true,
        })
        .png()
        .toBuffer({ resolveWithObject: true });
      return {
        data,
        info : {
          width  : info.width,
          height : info.height,
        },
      };
    },
  };
}
module.exports = { imageProcessor };
