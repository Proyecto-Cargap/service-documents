/**
 * @file Controladores de mensajería de documentos PDF. Adaptan los datos recibidos a las
 * operaciones de
 * aplicación y construyen sus respuestas.
 */

'use strict';
const { ApplicationError } = require('../../../shared/application-error');

/**
 * Construye los handlers RPC de generación de PDF con dependencias inyectadas.
 *
 * @param {Object} dependencies Componentes de aplicación de esta instancia.
 * @param {Object} dependencies.messaging Constructores de sobres de respuesta RPC.
 * @param {Function} dependencies.pdfService Constructor del servicio; cada mensaje recibe una
 * instancia propia.
 * @returns {Object<string, Function>} Handlers públicos registrados por el catálogo de mensajería.
 */
module.exports = function pdfController(dependencies) {
  const handlers   = {};
  const messaging  = dependencies.messaging;
  const pdfService = dependencies.pdfService;

  /**
   * Genera un PDF a partir de contenido HTML mediante el servicio de renderizado.
   * Devuelve los datos del PDF temporal; el transporte consumidor gestiona su transferencia y
   * limpieza.
   *
   * @param {Object} mqMessage Mensaje RPC del despachador.
   * @param {Object} mqMessage.data Entrada con html; admite filename, title y reference.
   * @returns {Promise<Object>} Sobre 200 con descriptionCode OK; data contiene el resultado del
   * servicio.
   * @throws {Error} Propaga los fallos del servicio para que el despachador construya el sobre de
   * error.
   */
  handlers.richDescriptionCreate = async (mqMessage) => {
    const pdfServiceInstance = new pdfService();
    const pdfServiceData     = await pdfServiceInstance.richDescriptionCreate(mqMessage.data);
    return messaging.successResponse(200, pdfServiceData);
  };

  /**
   * Genera el PDF de la cotización recibida.
   * Devuelve los datos del PDF temporal; el transporte consumidor gestiona su transferencia y
   * limpieza.
   *
   * @param {Object} mqMessage Mensaje RPC del despachador.
   * @param {Object} mqMessage.data Entrada con quotation.
   * @returns {Promise<Object>} Sobre 200 con descriptionCode OK; data contiene el resultado del
   * servicio.
   * @throws {Error} Propaga los fallos del servicio para que el despachador construya el sobre de
   * error.
   */
  handlers.quoteCreate = async (mqMessage) => {
    if (mqMessage.originService !== 'service-quotation')
      throw new ApplicationError(403, 'PDF_QUOTATION_ORIGIN_REQUIRED');
    const pdfServiceInstance = new pdfService();
    const pdfServiceData     = await pdfServiceInstance.quoteCreate(mqMessage.data);
    return messaging.successResponse(200, pdfServiceData);
  };

  /**
   * Genera el PDF del comprobante CNR recibido.
   * Devuelve los datos del PDF temporal; el transporte consumidor gestiona su transferencia y
   * limpieza.
   *
   * @param {Object} mqMessage Mensaje RPC del despachador.
   * @param {Object} mqMessage.data Entrada con cnr.
   * @returns {Promise<Object>} Sobre 200 con descriptionCode OK; data contiene el resultado del
   * servicio.
   * @throws {Error} Propaga los fallos del servicio para que el despachador construya el sobre de
   * error.
   */
  handlers.cnrCreate = async (mqMessage) => {
    const pdfServiceInstance = new pdfService();
    const pdfServiceData     = await pdfServiceInstance.cnrCreate(mqMessage.data);
    return messaging.successResponse(200, pdfServiceData);
  };

  /**
   * Genera el PDF de la orden de compra recibida.
   * Devuelve los datos del PDF temporal; el transporte consumidor gestiona su transferencia y
   * limpieza.
   *
   * @param {Object} mqMessage Mensaje RPC del despachador.
   * @param {Object} mqMessage.data Entrada con document.
   * @returns {Promise<Object>} Sobre 200 con descriptionCode OK; data contiene el resultado del
   * servicio.
   * @throws {Error} Propaga los fallos del servicio para que el despachador construya el sobre de
   * error.
   */
  handlers.purchaseOrderCreate = async (mqMessage) => {
    const pdfServiceInstance = new pdfService();
    const pdfServiceData     = await pdfServiceInstance.purchaseOrderCreate(mqMessage.data);
    return messaging.successResponse(200, pdfServiceData);
  };

  /**
   * Genera el PDF de la factura recibida.
   * Devuelve los datos del PDF temporal; el transporte consumidor gestiona su transferencia y
   * limpieza.
   *
   * @param {Object} mqMessage Mensaje RPC del despachador.
   * @param {Object} mqMessage.data Entrada con document.
   * @returns {Promise<Object>} Sobre 200 con descriptionCode OK; data contiene el resultado del
   * servicio.
   * @throws {Error} Propaga los fallos del servicio para que el despachador construya el sobre de
   * error.
   */
  handlers.invoiceCreate = async (mqMessage) => {
    const pdfServiceInstance = new pdfService();
    const pdfServiceData     = await pdfServiceInstance.invoiceCreate(mqMessage.data);
    return messaging.successResponse(200, pdfServiceData);
  };

  /**
   * Genera el PDF de cancelación a partir del documento y su XML de cancelación.
   * Devuelve los datos del PDF temporal; el transporte consumidor gestiona su transferencia y
   * limpieza.
   *
   * @param {Object} mqMessage Mensaje RPC del despachador.
   * @param {Object} mqMessage.data Entrada con document, incluido document.cancellationXml.
   * @returns {Promise<Object>} Sobre 200 con descriptionCode OK; data contiene el resultado del
   * servicio.
   * @throws {Error} Propaga los fallos del servicio para que el despachador construya el sobre de
   * error.
   */
  handlers.invoiceCancelCreate = async (mqMessage) => {
    const pdfServiceInstance = new pdfService();
    const pdfServiceData     = await pdfServiceInstance.invoiceCancelCreate(mqMessage.data);
    return messaging.successResponse(200, pdfServiceData);
  };

  /**
   * Genera el PDF del complemento recibido.
   * Devuelve los datos del PDF temporal; el transporte consumidor gestiona su transferencia y
   * limpieza.
   *
   * @param {Object} mqMessage Mensaje RPC del despachador.
   * @param {Object} mqMessage.data Entrada con document.
   * @returns {Promise<Object>} Sobre 200 con descriptionCode OK; data contiene el resultado del
   * servicio.
   * @throws {Error} Propaga los fallos del servicio para que el despachador construya el sobre de
   * error.
   */
  handlers.complementCreate = async (mqMessage) => {
    const pdfServiceInstance = new pdfService();
    const pdfServiceData     = await pdfServiceInstance.complementCreate(mqMessage.data);
    return messaging.successResponse(200, pdfServiceData);
  };
  /** @param {Object} message Proyección del XML acreditada por Billing. @returns {Promise<Object>} Temporal privado, sin publicar archivos QR. */
  handlers.billingCreate = async (message) => {
    if (message.originService !== 'service-billing')
      throw new ApplicationError(403, 'PDF_BILLING_ORIGIN_REQUIRED');
    return messaging.successResponse(200, await new pdfService().billingCreate(message.data));
  };
  /** @param {Object} message Vista comercial acreditada por Billing. @returns {Promise<Object>} PDF privado no fiscal. */
  handlers.commercialCreate = async (message) => {
    if (message.originService !== 'service-billing')
      throw new ApplicationError(403, 'PDF_BILLING_ORIGIN_REQUIRED');
    return messaging.successResponse(200, await new pdfService().commercialCreate(message.data));
  };
  return handlers;
};
