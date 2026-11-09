/** @file Adaptación RPC del catálogo documental por IDs; no interpreta autoridad del payload. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
/**
 * Construye handlers sobre el servicio documental inyectado, sin efectos de construcción.
 * @param {Object} dependencies Mensajería y servicio que coordina autorización y persistencia.
 * @returns {Object} Operaciones públicas del contrato documental v1.
 */
module.exports = function documentsController({ messaging, documentsService }) {
  return {
    /**
     * Lista la papelera autorizada de una raíz.
     * @param {Object} message Raíz y consulta de paginación acreditadas.
     * @returns {Promise<Object>} Sobre 200 con metadatos y vencimiento.
     */
    async getTrash(message) {
      return messaging.successResponse(200, await documentsService.getTrash(message.data));
    },
    /**
     * Restaura un subárbol conservado en papelera.
     * @param {Object} message Identificador y revisión de la entrada.
     * @returns {Promise<Object>} Sobre 200 con entrada restaurada.
     */
    async restore(message) {
      return messaging.successResponse(200, await documentsService.restore(message.data));
    },
    /**
     * Proyecta la página privada solicitada por el adaptador verificado de Platform.
     * @param {Object} message Origen acreditado, ubicación y consulta de la vista.
     * @returns {Promise<Object>} Sobre 200 con página y metadatos autorizados.
     */
    async getView(message) {
      if (message.originService !== 'service-platform')
        throw new ApplicationError(403, 'FORBIDDEN');
      return messaging.successResponse(200, await documentsService.getView(message.data));
    },
    /**
     * Ejecuta createFolder con la identidad verificada por mensajería.
     * @param {Object} mqMessage Mensaje con los IDs y campos del caso de uso.
     * @returns {Promise<Object>} Sobre 201 con DTO, sin claves de almacenamiento.
     */
    async createFolder(mqMessage) {
      return messaging.successResponse(201, await documentsService.createFolder(mqMessage.data));
    },
    /**
     * Ejecuta getOne con la identidad verificada por mensajería.
     * @param {Object} mqMessage Mensaje con los IDs y campos del caso de uso.
     * @returns {Promise<Object>} Sobre 200 con DTO, sin claves de almacenamiento.
     */
    async getOne(mqMessage) {
      return messaging.successResponse(200, await documentsService.getOne(mqMessage.data));
    },
    /**
     * Ejecuta getList con la identidad verificada por mensajería.
     * @param {Object} mqMessage Mensaje con los IDs y campos del caso de uso.
     * @returns {Promise<Object>} Sobre 200 con DTO, sin claves de almacenamiento.
     */
    async getList(mqMessage) {
      return messaging.successResponse(200, await documentsService.getList(mqMessage.data));
    },
    /**
     * Ejecuta rename con la identidad verificada por mensajería.
     * @param {Object} mqMessage Mensaje con los IDs y campos del caso de uso.
     * @returns {Promise<Object>} Sobre 200 con DTO, sin claves de almacenamiento.
     */
    async rename(mqMessage) {
      return messaging.successResponse(200, await documentsService.rename(mqMessage.data));
    },
    /**
     * Ejecuta delete con la identidad verificada por mensajería.
     * @param {Object} mqMessage Mensaje con los IDs y campos del caso de uso.
     * @returns {Promise<Object>} Sobre 200 con DTO, sin claves de almacenamiento.
     */
    async delete(mqMessage) {
      return messaging.successResponse(200, await documentsService.delete(mqMessage.data));
    },
    /**
     * Ejecuta getRepositories con la identidad verificada por mensajería.
     * @param {Object} mqMessage Mensaje con los IDs y campos del caso de uso.
     * @returns {Promise<Object>} Sobre 200 con DTO, sin claves de almacenamiento.
     */
    async getRepositories(mqMessage) {
      return messaging.successResponse(200, await documentsService.getRepositories(mqMessage.data));
    },
    /**
     * Ejecuta upload con la identidad verificada por mensajería.
     * @param {Object} mqMessage Mensaje con los IDs y campos del caso de uso.
     * @returns {Promise<Object>} Sobre 201 con DTO, sin claves de almacenamiento.
     */
    async upload(mqMessage) {
      return messaging.successResponse(201, await documentsService.upload(mqMessage.data));
    },
    /**
     * Ejecuta move con la identidad verificada por mensajería.
     * @param {Object} mqMessage Mensaje con los IDs y campos del caso de uso.
     * @returns {Promise<Object>} Sobre 200 con DTO, sin claves de almacenamiento.
     */
    async move(mqMessage) {
      return messaging.successResponse(200, await documentsService.move(mqMessage.data));
    },
    /**
     * Ejecuta download con la identidad verificada por mensajería.
     * @param {Object} mqMessage Mensaje con los IDs y campos del caso de uso.
     * @returns {Promise<Object>} Sobre 200 con DTO, sin claves de almacenamiento.
     */
    async download(mqMessage) {
      return messaging.successResponse(200, await documentsService.download(mqMessage.data));
    },
    /**
     * Ejecuta getFavorites con la identidad verificada por mensajería.
     * @param {Object} mqMessage Mensaje con los IDs y campos del caso de uso.
     * @returns {Promise<Object>} Sobre 200 con DTO, sin claves de almacenamiento.
     */
    async getFavorites(mqMessage) {
      return messaging.successResponse(200, await documentsService.getFavorites(mqMessage.data));
    },
    /**
     * Ejecuta addFavorite con la identidad verificada por mensajería.
     * @param {Object} mqMessage Mensaje con los IDs y campos del caso de uso.
     * @returns {Promise<Object>} Sobre 200 con DTO, sin claves de almacenamiento.
     */
    async addFavorite(mqMessage) {
      return messaging.successResponse(200, await documentsService.addFavorite(mqMessage.data));
    },
    /**
     * Ejecuta removeFavorite con la identidad verificada por mensajería.
     * @param {Object} mqMessage Mensaje con los IDs y campos del caso de uso.
     * @returns {Promise<Object>} Sobre 200 con DTO, sin claves de almacenamiento.
     */
    async removeFavorite(mqMessage) {
      return messaging.successResponse(200, await documentsService.removeFavorite(mqMessage.data));
    },
  };
};
