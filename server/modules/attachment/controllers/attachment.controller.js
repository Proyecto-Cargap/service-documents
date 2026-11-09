/** @file Adaptación RPC privada de adjuntos; el origen lo acredita la mensajería. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
/**
 * Construye los handlers de almacenamiento privado.
 * @param {Object} dependencies Servicio y mensajería.
 * @returns {Object} Operaciones internas con respuesta uniforme.
 */
function attachmentController({ service, messaging }) {
  return {
    /** Prepara una miniatura privada para Communication, sin exponer el original al navegador.
     * @param {Object} mqMessage Código del adjunto y origen acreditado.
     * @returns {Promise<Object>} Sobre 200 con temporal WebP o error de imagen/acceso.
     */
    async preview(mqMessage) {
      if (!mqMessage?.data || typeof mqMessage.data !== 'object' || Array.isArray(mqMessage.data))
        throw new ApplicationError(400, 'INVALID_INPUT');
      return messaging.successResponse(
        200,
        await service.preview(mqMessage.data, mqMessage.originService),
      );
    },
    /**
     * Conciliación privada de una carga cuya respuesta pudo perderse.
     * @param {Object} mqMessage Identidad de adjunto y conversación original.
     * @returns {Promise<Object>} Estado y metadatos confirmados.
     */
    async status(mqMessage) {
      if (
        !mqMessage ||
        !mqMessage.data ||
        typeof mqMessage.data !== 'object' ||
        Array.isArray(mqMessage.data)
      )
        throw new ApplicationError(400, 'INVALID_INPUT');
      return messaging.successResponse(
        200,
        await service.status(mqMessage.data, mqMessage.originService),
      );
    },
    /**
     * Retira un temporal de descarga que ya no puede entregarse al solicitante.
     * @param {Object} mqMessage Identificador y temporal devueltos por Documents.
     * @returns {Promise<Object>} Confirmación del retiro privado.
     */
    async discard(mqMessage) {
      if (
        !mqMessage ||
        !mqMessage.data ||
        typeof mqMessage.data !== 'object' ||
        Array.isArray(mqMessage.data)
      )
        throw new ApplicationError(400, 'INVALID_INPUT');
      return messaging.successResponse(
        200,
        await service.discard(mqMessage.data, mqMessage.originService),
      );
    },
    /**
     * Carga el archivo temporal mediante almacenamiento privado.
     * @param {Object} mqMessage Archivo temporal.
     * @returns {Promise<Object>} Metadatos de carga persistida.
     */
    async upload(mqMessage) {
      if (
        !mqMessage ||
        !mqMessage.data ||
        typeof mqMessage.data !== 'object' ||
        Array.isArray(mqMessage.data)
      )
        throw new ApplicationError(400, 'INVALID_INPUT');
      return messaging.successResponse(
        200,
        await service.upload(mqMessage.data, mqMessage.originService),
      );
    },
    /**
     * Prepara la descarga privada del adjunto acreditado.
     * @param {Object} mqMessage Código de adjunto.
     * @returns {Promise<Object>} Temporal privado descargable.
     */
    async download(mqMessage) {
      if (
        !mqMessage ||
        !mqMessage.data ||
        typeof mqMessage.data !== 'object' ||
        Array.isArray(mqMessage.data)
      )
        throw new ApplicationError(400, 'INVALID_INPUT');
      return messaging.successResponse(
        200,
        await service.download(mqMessage.data, mqMessage.originService),
      );
    },
    /**
     * Libera el archivo y su cuota cuando Communication acredita abandono.
     * @param {Object} mqMessage Código abandonado.
     * @returns {Promise<Object>} Confirmación de limpieza.
     */
    async delete(mqMessage) {
      if (
        !mqMessage ||
        !mqMessage.data ||
        typeof mqMessage.data !== 'object' ||
        Array.isArray(mqMessage.data)
      )
        throw new ApplicationError(400, 'INVALID_INPUT');
      return messaging.successResponse(
        200,
        await service.delete(mqMessage.data, mqMessage.originService),
      );
    },
  };
}
module.exports = attachmentController;
