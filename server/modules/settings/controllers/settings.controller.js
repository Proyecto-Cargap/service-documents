/** @file Handlers RPC de parámetros de configuración persistidos y autorizados. */
const { ApplicationError } = require('../../../shared/application-error');
/**
 * Construye los handlers RPC de parámetros de configuración con dependencias inyectadas.
 *
 * @param {Object} dependencies Componentes de aplicación de esta instancia.
 * @param {Object} dependencies.messaging Constructores de sobres de respuesta RPC.
 * @param {Object} dependencies.settingsRepository Repositorio técnico con get, getAll y update.
 * @param {Object} dependencies.identity Identidad usada en los códigos de error del módulo.
 * @returns {Object<string, Function>} Handlers públicos registrados por el catálogo de mensajería.
 */
module.exports = function settingsController(dependencies) {
  const handlers = {};

  const messaging          = dependencies.messaging;
  const settingsRepository = dependencies.settingsRepository;
  const { id }             = dependencies.identity;
  const controller         = 'C000';

  /**
   * Consulta un parámetro autorizado y rechaza la ausencia del parámetro o del registro.
   *
   * @param {Object} mqMessage Mensaje RPC del despachador.
   * @param {Object} mqMessage.data Entrada con parameter; admite scope.
   * @returns {Promise<Object>} Sobre 200 con descriptionCode OK; data contiene el resultado del
   * repositorio de configuración.
   * @throws {ApplicationError} Conserva errores de aplicación; los fallos inesperados se convierten
   * en 500.
   */
  handlers.getOne = async (mqMessage) => {
    try {
      if (mqMessage.data.parameter == undefined) {
        throw new ApplicationError(400, `${id}-${controller}-E0001:Parameter is required`);
      }
      const settings = await settingsRepository.get(
        mqMessage.data.parameter,
        mqMessage?.data?.scope === undefined ? '' : mqMessage.data.scope,
      );
      if (!settings) {
        throw new ApplicationError(400, `${id}-${controller}-E0002:Settings does not exist`);
      }
      return messaging.successResponse(200, settings);
    } catch (err) {
      if (err instanceof ApplicationError) throw err;
      throw new ApplicationError(500, 'OPERATION_FAILED');
    }
  };

  /**
   * Obtiene los parámetros visibles para el alcance solicitado, sin paginación.
   *
   * @param {Object} mqMessage Mensaje RPC del despachador.
   * @param {Object} mqMessage.data Entrada con scope opcional.
   * @returns {Promise<Object>} Sobre 200 con descriptionCode OK; data contiene el resultado del
   * repositorio de configuración.
   * @throws {ApplicationError} Conserva errores de aplicación; los fallos inesperados se convierten
   * en 500.
   */
  handlers.getList = async (mqMessage) => {
    try {
      require('../../../shared/general').getPublicPagination(mqMessage?.data || {});
      const settings = await settingsRepository.getAll(
        mqMessage?.data?.scope === undefined ? '' : mqMessage.data.scope,
      );
      return messaging.successResponse(200, settings);
    } catch (err) {
      if (err instanceof ApplicationError) throw err;
      throw new ApplicationError(500, 'OPERATION_FAILED');
    }
  };

  /**
   * Actualiza los datos del parámetro autorizado y rechaza la ausencia de entrada o registro.
   *
   * @param {Object} mqMessage Mensaje RPC del despachador.
   * @param {Object} mqMessage.data Entrada con parameter y data; admite scope.
   * @returns {Promise<Object>} Sobre 200 con descriptionCode OK y data vacío al completar la
   * operación.
   * @throws {ApplicationError} Conserva errores de aplicación; los fallos inesperados se convierten
   * en 500.
   */
  handlers.update = async (mqMessage) => {
    try {
      if (!mqMessage.data.parameter) {
        throw new ApplicationError(400, `${id}-${controller}-E0001:Parameter is required`);
      }
      if (!mqMessage.data.data) {
        throw new ApplicationError(400, `${id}-${controller}-E0003:Data is required`);
      }
      if (
        !(await settingsRepository.update(
          mqMessage.data.parameter,
          mqMessage.data.data,
          mqMessage?.data?.scope === undefined ? '' : mqMessage.data.scope,
        ))
      ) {
        throw new ApplicationError(400, `${id}-${controller}-E0002:Settings does not exist`);
      }
      return messaging.successResponse(200);
    } catch (err) {
      if (err instanceof ApplicationError) throw err;
      throw new ApplicationError(500, 'OPERATION_FAILED');
    }
  };
  return handlers;
};
