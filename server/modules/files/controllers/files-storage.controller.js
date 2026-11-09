/** @file Operaciones RPC de almacenamiento autorizadas por el dominio invocador. */
'use strict';
/**
 * Construye los adaptadores del contrato interno de Files.
 * @param {Object} dependencies Servicio técnico y mensajería.
 * @returns {Object} Handlers de carga, lectura, limpieza y lectura pública.
 */
module.exports = function filesStorageController({ service, messaging }) {
  return {
    /**
     * Guarda un archivo acreditado por el dominio invocador.
     * @param {Object} message Datos y origen verificado del mensaje.
     * @returns {Promise<Object>} Referencia de archivo creado.
     */
    async upload(message) {
      return messaging.successResponse(
        201,
        await service.upload(message.data, message.originService),
      );
    },
    /**
     * Prepara una lectura acreditada por el dominio propietario.
     * @param {Object} message Identidad y tamaño del archivo.
     * @returns {Promise<Object>} Temporal y metadatos de transferencia.
     */
    async read(message) {
      return messaging.successResponse(
        200,
        await service.read(message.data, message.originService),
      );
    },
    /**
     * Retira un archivo acreditado por el dominio propietario.
     * @param {Object} message Identidad del archivo y recurso.
     * @returns {Promise<Object>} Confirmación de limpieza.
     */
    async remove(message) {
      return messaging.successResponse(
        200,
        await service.remove(message.data, message.originService),
      );
    },
    /**
     * Lee sólo un archivo explícitamente público.
     * @param {Object} message Identidad y tamaño solicitado.
     * @returns {Promise<Object>} Temporal público y metadatos.
     */
    async readPublic(message) {
      return messaging.successResponse(200, await service.readPublic(message.data));
    },
  };
};
