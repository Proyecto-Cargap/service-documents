/**
 * @file Controladores de mensajería de archivos. Adaptan los datos recibidos a las operaciones de
 * aplicación y construyen sus respuestas.
 */

'use strict';

const { ApplicationError } = require('../../../shared/application-error');
/**
 * Construye los handlers RPC de archivos con dependencias inyectadas.
 *
 * @param {Object} dependencies Componentes de aplicación de esta instancia.
 * @param {Object} dependencies.messaging Constructores de sobres de respuesta RPC.
 * @param {Function} dependencies.filesService Constructor del servicio; cada mensaje recibe una
 * instancia propia.
 * @param {Object} dependencies.identity Identidad usada en los códigos de error del módulo.
 * @returns {Object<string, Function>} Handlers públicos registrados por el catálogo de mensajería.
 */
module.exports = function filesController(dependencies) {
  const handlers     = {};
  const messaging    = dependencies.messaging;
  const { id }       = dependencies.identity;
  const filesService = dependencies.filesService;
  const controller   = 'C001';

  /**
   * Carga un archivo mediante el servicio y devuelve su recurso creado.
   * scope define privacidad public/private; accessScope es el selector de autorización.
   *
   * @param {Object} mqMessage Mensaje RPC del despachador.
   * @param {Object} mqMessage.data Entrada con module, userCode, fileName, tempFilePath y scope;
   * admite accessScope, workspace, userAssigned, thumbnail y cleanTemp.
   * @returns {Promise<Object>} Sobre 201 con descriptionCode OK; data contiene el resultado del
   * servicio.
   * @throws {Error} Propaga los fallos del servicio para que el despachador construya el sobre de
   * error.
   */
  handlers.create = async (mqMessage) => {
    const filesServiceInstance = new filesService();
    const response             = await filesServiceInstance.create(mqMessage.data);
    return messaging.successResponse(201, response);
  };

  /**
   * Obtiene el archivo autorizado en un temporal para su transferencia.
   *
   * @param {Object} mqMessage Mensaje RPC del despachador.
   * @param {Object} mqMessage.data Entrada con code; admite size y accessScope.
   * @returns {Promise<Object>} Sobre 200 con descriptionCode OK; data contiene el resultado del
   * servicio.
   * @throws {ApplicationError} Rechaza con 400 los campos obligatorios ausentes.
   * @throws {Error} Propaga los fallos del servicio para que el despachador construya el sobre de
   * error.
   */
  handlers.getOne = async (mqMessage) => {
    if (mqMessage.data.code == undefined || mqMessage.data.code == '') {
      throw new ApplicationError(400, `${id}-${controller}-E0010:code is required`);
    }
    const filesServiceInstance = new filesService();
    const response             = await filesServiceInstance.getOne(mqMessage.data);
    return messaging.successResponse(200, response);
  };

  /**
   * Sustituye el contenido del archivo identificado y devuelve el recurso actualizado.
   * scope define privacidad public/private; accessScope es el selector de autorización.
   *
   * @param {Object} mqMessage Mensaje RPC del despachador.
   * @param {Object} mqMessage.data Entrada con code, module, userCode, fileName, tempFilePath y
   * scope; admite accessScope, workspace, userAssigned, thumbnail y cleanTemp.
   * @returns {Promise<Object>} Sobre 200 con descriptionCode OK; data contiene el resultado del
   * servicio.
   * @throws {ApplicationError} Rechaza con 400 los campos obligatorios ausentes.
   * @throws {Error} Propaga los fallos del servicio para que el despachador construya el sobre de
   * error.
   */
  handlers.update = async (mqMessage) => {
    if (mqMessage.data.code == undefined || mqMessage.data.code == '') {
      throw new ApplicationError(400, `${id}-${controller}-E0030:code is required`);
    }
    if (mqMessage.data.module == undefined || mqMessage.data.module == '') {
      throw new ApplicationError(400, `${id}-${controller}-E0040:module is required`);
    }
    if (mqMessage.data.userCode == undefined || mqMessage.data.userCode == '') {
      throw new ApplicationError(400, `${id}-${controller}-E0050:userCode is required`);
    }
    if (mqMessage.data.fileName == undefined || mqMessage.data.fileName == '') {
      throw new ApplicationError(400, `${id}-${controller}-E0060:fileName is required`);
    }
    if (mqMessage.data.tempFilePath == undefined || mqMessage.data.tempFilePath == '') {
      throw new ApplicationError(400, `${id}-${controller}-E0070:tempFilePath is required`);
    }
    if (mqMessage.data.scope == undefined || mqMessage.data.scope == '') {
      throw new ApplicationError(400, `${id}-${controller}-E0080:scope is required`);
    }
    const filesServiceInstance = new filesService();
    const response             = await filesServiceInstance.update(mqMessage.data);
    return messaging.successResponse(200, response);
  };

  /**
   * Elimina el archivo identificado por code o por la propiedad urlResorce.
   * Si el servicio devuelve null, conserva el sobre 200 con descripción de ausencia y sin data.
   *
   * @param {Object} mqMessage Mensaje RPC del despachador.
   * @param {Object} mqMessage.data Entrada con code o urlResorce; admite accessScope.
   * @returns {Promise<Object>} Sobre 200 con descriptionCode OK y data vacío al completar la
   * operación.
   * @throws {Error} Propaga los fallos del servicio para que el despachador construya el sobre de
   * error.
   */
  handlers.delete = async (mqMessage) => {
    const filesServiceInstance = new filesService();
    const filesServiceData     = await filesServiceInstance.delete(mqMessage.data);
    if (filesServiceData === null)
      return messaging.errorResponse(
        200,
        `${(mqMessage.data.code || mqMessage.data.urlResorce.split('/').pop()).split('-')[0]}-C005-E0009:File no found`,
      );
    return messaging.successResponse(200);
  };

  /**
   * Copia el archivo autorizado y devuelve los datos del nuevo recurso.
   *
   * @param {Object} mqMessage Mensaje RPC del despachador.
   * @param {Object} mqMessage.data Entrada con code o urlResorce; admite accessScope, workspace y
   * userAssigned.
   * @returns {Promise<Object>} Sobre 201 con descriptionCode OK; data contiene el resultado del
   * servicio.
   * @throws {Error} Propaga los fallos del servicio para que el despachador construya el sobre de
   * error.
   */
  handlers.clone = async (mqMessage) => {
    const filesServiceInstance = new filesService();
    const response             = await filesServiceInstance.clone(mqMessage.data);
    return messaging.successResponse(201, response);
  };
  return handlers;
};
