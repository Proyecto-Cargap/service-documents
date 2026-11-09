/**
 * @file Controladores de mensajería de códigos QR. Adaptan los datos recibidos a las operaciones de
 * aplicación y construyen sus respuestas.
 */

'use strict';

/**
 * Construye los handlers RPC de códigos QR con dependencias inyectadas.
 *
 * @param {Object} dependencies Componentes de aplicación de esta instancia.
 * @param {Object} dependencies.messaging Constructores de sobres de respuesta RPC.
 * @param {Function} dependencies.qrcodeService Constructor del servicio; cada mensaje recibe una
 * instancia propia.
 * @returns {Object<string, Function>} Handlers públicos registrados por el catálogo de mensajería.
 */
module.exports = function qrcodeController(dependencies) {
  const handlers      = {};
  const messaging     = dependencies.messaging;
  const qrcodeService = dependencies.qrcodeService;

  /**
   * Genera el QR del contenido recibido y guarda el archivo mediante el servicio.
   *
   * @param {Object} mqMessage Mensaje RPC del despachador.
   * @param {Object} mqMessage.data Entrada con content; admite accessScope, workspace,
   * userAssigned, image, dotsColor, backgroundColor, fileName y userCode.
   * @returns {Promise<Object>} Sobre 201 con descriptionCode OK; data contiene el resultado del
   * servicio.
   * @throws {Error} Propaga los fallos del servicio para que el despachador construya el sobre de
   * error.
   */
  handlers.create = async (mqMessage) => {
    const qrcodeServiceInstance = new qrcodeService();
    const qrcodeServiceData     = await qrcodeServiceInstance.create(mqMessage.data);
    return messaging.successResponse(201, qrcodeServiceData);
  };

  /**
   * Decodifica el contenido QR de un archivo temporal validado por el servicio.
   *
   * @param {Object} mqMessage Mensaje RPC del despachador.
   * @param {Object} mqMessage.data Entrada con tempFilePath.
   * @returns {Promise<Object>} Sobre 201 con descriptionCode OK; data contiene el resultado del
   * servicio.
   * @throws {Error} Propaga los fallos del servicio para que el despachador construya el sobre de
   * error.
   */
  handlers.decode = async (mqMessage) => {
    const qrcodeServiceInstance = new qrcodeService();
    const qrcodeServiceData     = await qrcodeServiceInstance.decode(mqMessage.data);
    return messaging.successResponse(201, qrcodeServiceData);
  };
  return handlers;
};
