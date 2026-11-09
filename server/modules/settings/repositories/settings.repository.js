/** @file Parámetros técnicos globales; el servidor selecciona guest y fija su autoría. */
'use strict';
const { ApplicationError }   = require('../../../shared/application-error');
const policy                 = require('../policies/settings.policy');
const { trashRetentionDays } = require('../../../shared/document-retention');
/**
 * Compone createSettingsRepository con las dependencias recibidas y devuelve su interfaz.
 * @param {Object} options Colaboradores u opciones: model, messaging.
 * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
module.exports = function createSettingsRepository({ model, messaging, getSession }) {
  const commit = require('../../../adapters/mongodb/document-changes').documentChanges({
    model,
    messaging,
    getSession,
    resource : 'settings',
  });
  return {
    /**
     * Reserva o libera bytes sin sobrescribir ajustes concurrentes del consumo compartido.
     * @param {number} delta Bytes a reservar o cantidad negativa que se libera.
     * @param {string|symbol} scope Alcance de autorización propio de Settings.
     * @param {Object} options Reglas de capacidad y transacción del llamador.
     * @param {boolean} [options.reserve] Comprueba capacidad y límite por archivo al reservar.
     * @param {number} [options.fileSize] Tamaño total que se contrasta con sizeFileMax.
     * @param {import('mongoose').ClientSession} [options.session] Sesión compartida con el ledger del adjunto.
     * @returns {Promise<Object>} Configuración posterior al ajuste atómico.
     */
    async adjustUsedSpace(delta, scope = '', options = {}) {
      if (!Number.isSafeInteger(delta) || !options || typeof options !== 'object')
        throw new ApplicationError(400, 'INVALID_CAPACITY_CHANGE');
      const filter = policy.authorize(
        'update',
        { parameter: 'documents-settings' },
        scope,
        messaging?.getContext() || {},
      );
      if (!filter) throw new ApplicationError(403, 'FORBIDDEN');
      const constraints = [
        filter,
        {
          'data.usedSpace' : {
            $type : 'number',
            $gte  : Math.max(0, -delta),
          },
        },
      ];
      if (options.reserve) {
        const fileSize = options.fileSize;
        if (!Number.isSafeInteger(fileSize) || fileSize < 0)
          throw new ApplicationError(400, 'INVALID_FILE_SIZE');
        if (fileSize > 200 * 1024 * 1024)
          throw new ApplicationError(413, 'DOCUMENT_FILE_TOO_LARGE');
        const query    = model.findOne(filter);
        const settings = await (options.session ? query.session(options.session) : query);
        const data     = settings?.data;
        if (
          !data ||
          !['usedSpace', 'availableSpace', 'sizeFileMax'].every(
            /**
             * Comprueba la condición requerida para cada elemento.
             * @param {string} key Clave del campo o recurso que se procesa.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            (key) => Number.isSafeInteger(data[key]) && data[key] >= 0,
          ) ||
          data.sizeFileMax === 0
        )
          throw new ApplicationError(503, 'DOCUMENT_SETTINGS_INVALID');
        if (fileSize > data.sizeFileMax) throw new ApplicationError(413, 'DOCUMENT_FILE_TOO_LARGE');
        constraints.push({
          'data.availableSpace' : {
            $type : 'number',
            $gte  : 0,
          },
          'data.sizeFileMax'    : {
            $type : 'number',
            $gte  : fileSize,
          },
          $expr                 : { $lte: [{ $add: ['$data.usedSpace', delta] }, '$data.availableSpace'] },
        });
      }
      const result = await commit(
        /** @param {Object} session Transacción del ledger o del ajuste. @returns {Promise<Object>} Consumo, revisión y evento se confirman juntos. */
        (session) =>
          model.findOneAndUpdate(
            { $and: constraints },
            {
              $inc : {
                'data.usedSpace' : delta,
                revision         : 1,
              },
            },
            {
              returnDocument : 'after',
              runValidators  : true,
              session,
            },
          ),
        options.session,
      );
      if (!result)
        throw new ApplicationError(
          409,
          options.reserve ? 'DOCUMENT_CAPACITY_EXCEEDED' : 'DOCUMENT_CAPACITY_INCONSISTENT',
        );
      return result;
    },
    /**
     * Crea el registro y devuelve el resultado de la operación.
     * @param {*} parameter Valor de parameter utilizado por esta operación.
     * @param {Object} data Datos de entrada de la operación.
     * @param {string|symbol} [scope] Alcance solicitado o marcador interno de confianza.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async create(parameter, data, scope = '') {
      if (typeof parameter !== 'string' || !parameter)
        throw new ApplicationError(400, 'INVALID_INPUT');
      if (parameter === 'documents-settings') trashRetentionDays(data);
      const context = messaging?.getContext() || {};
      const input   = policy.authorize(
        'create',
        {
          parameter,
          data,
          workspace    : 'allWorkspaces',
          userCreate   : context.user?.userCode || '',
          userAssigned : '',
        },
        scope,
        context,
      );
      if (!input) throw new ApplicationError(403, 'FORBIDDEN');
      return commit(
        /** @param {Object} session Unidad de alta. @returns {Promise<Object>} Configuración confirmada. */
        (session) => new model(input).save({ session }),
      );
    },
    /**
     * Obtiene el valor solicitado.
     * @param {*} parameter Valor de parameter utilizado por esta operación.
     * @param {string|symbol} [scope] Alcance solicitado o marcador interno de confianza.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async get(parameter, scope = '') {
      if (typeof parameter !== 'string' || !parameter)
        throw new ApplicationError(400, 'INVALID_INPUT');
      const filter = policy.authorize('view', { parameter }, scope, messaging?.getContext() || {});
      return filter ? model.findOne(filter).session(getSession?.() || null) : null;
    },
    /**
     * Resuelve getAll aplicando los filtros y colaboradores del módulo.
     * @param {string|symbol} [scope] Alcance solicitado o marcador interno de confianza.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async getAll(scope = '') {
      const filter = policy.authorize('view', {}, scope, messaging?.getContext() || {});
      if (!filter) return [];
      const items = await model
        .find(filter)
        .limit(101)
        .session(getSession?.() || null);
      if (items.length > 100) throw new ApplicationError(409, 'SETTINGS_COLLECTION_TOO_LARGE');
      return items;
    },
    /**
     * Actualiza los campos autorizados del registro.
     * @param {*} parameter Valor de parameter utilizado por esta operación.
     * @param {Object} data Datos de entrada de la operación.
     * @param {string|symbol} [scope] Alcance solicitado o marcador interno de confianza.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async update(parameter, data, scope = '', expectedRevision) {
      if (typeof parameter !== 'string' || !parameter)
        throw new ApplicationError(400, 'INVALID_INPUT');
      if (
        parameter === 'documents-settings' &&
        (!data ||
          typeof data !== 'object' ||
          Array.isArray(data) ||
          Object.keys(data).some(
            /**
             * Comprueba si el elemento satisface la condición.
             * @param {string} key Clave del campo o recurso que se procesa.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            (key) => key.includes('.') || key.startsWith('$'),
          ))
      )
        throw new ApplicationError(400, 'INVALID_INPUT');
      if (parameter === 'documents-settings') trashRetentionDays(data);
      // El consumo sólo cambia mediante adjustUsedSpace, incluso en actualizaciones administrativas.
      const changes =
        parameter === 'documents-settings'
          ? {
              $set : Object.fromEntries(
                Object.entries(data)
                  .filter(
                    /**
                     * Determina si el elemento cumple el criterio de selección.
                     * @param {Array<*>} argument1 Valor de argument1 utilizado por esta operación.
                     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                     */
                    ([key]) => key !== 'usedSpace',
                  )
                  .map(
                    /**
                     * Proyecta cada elemento en la estructura requerida por la operación.
                     * @param {Array<*>} argument1 Valor de argument1 utilizado por esta operación.
                     * @returns {Array<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                     */
                    ([key, value]) => [`data.${key}`, value],
                  ),
              ),
            }
          : { $set: { data } };
      const filter  = policy.authorize('update', { parameter }, scope, {
        ...(messaging?.getContext() || {}),
        changes,
      });
      if (!filter) throw new ApplicationError(403, 'FORBIDDEN');
      changes.$inc = { revision: 1 };
      const revisionFilter =
        expectedRevision === undefined
          ? filter
          : {
              $and : [
                filter,
                expectedRevision === 0
                  ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] }
                  : { revision: expectedRevision },
              ],
            };
      const result         = await commit(
        /** @param {Object} session Unidad de configuración. @returns {Promise<Object>} CAS y hecho inseparables. */
        (session) =>
          model.findOneAndUpdate(revisionFilter, changes, {
            returnDocument : 'after',
            runValidators  : true,
            session,
          }),
      );
      if (!result && expectedRevision !== undefined)
        throw new ApplicationError(409, 'DOCUMENT_REVISION_CONFLICT');
      return result;
    },
  };
};
