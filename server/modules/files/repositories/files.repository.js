/** @file Persistencia de archivos; filtros vacíos explícitos seleccionan todos los registros. */
'use strict';

const { ApplicationError } = require('../../../shared/application-error');
const policy               = require('../policies/files.policy');

/**
 * Compone createFilesRepository con las dependencias recibidas y devuelve su interfaz.
 * @param {Object} options Colaboradores u opciones: model, messaging.
 * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
module.exports = function createFilesRepository({ model, messaging }) {
  return {
    /** @returns {Promise<Object>} Documento guardado, con defaults y validación del modelo.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @param {string|symbol} [scope] Alcance solicitado o marcador interno de confianza.
     */
    async create(input, scope = '') {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new ApplicationError(400, 'INVALID_INPUT');
      }
      const authorizedInput = policy.authorize('create', input, scope, messaging.getContext());
      if (!authorizedInput) throw new ApplicationError(403, 'FORBIDDEN');
      const document = new model(authorizedInput);
      return document.save();
    },

    /** @returns {Promise<Object|null>} Documento coincidente o null.
     * @param {Object} filter Filtros de selección que se autorizan antes de consultar.
     * @param {string|symbol} [scope] Alcance solicitado o marcador interno de confianza.
     * @param {*} [operation] Valor de operation utilizado por esta operación.
     * @param {Object} changes Valor de changes utilizado por esta operación.
     */
    async getOne(filter, scope = '', operation = 'view', changes) {
      if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
        throw new ApplicationError(400, 'INVALID_FILTER');
      }
      // Las imágenes grupales se consultan exclusivamente por membresía en Communication.
      const authorizedFilter = policy.authorize(
        operation,
        { $and: [filter, { resourceType: { $ne: 'chat-group-picture' } }] },
        scope,
        {
          ...messaging.getContext(),
          changes,
        },
      );
      if (!authorizedFilter) {
        if (operation !== 'view') throw new ApplicationError(403, 'FORBIDDEN');
        return null;
      }
      return model.findOne(authorizedFilter);
    },

    /**
     * @param {Object} filter Filtro explícito; no se modifica.
     * @param {Object} [sort] Orden de los resultados.
     * @param {number} [page] Página desde cero.
     * @param {number} [perPage] Tamaño de página; cero elimina el límite.
     * @param {string|Object} [fields] Proyección de campos.
     * @returns {Promise<{listItem: Object[], totalCount: number}>} Página y total sin paginar.
     */
    async getList(filter, sort = {}, page = 0, perPage = 20, fields = '', scope = '') {
      if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
        throw new ApplicationError(400, 'INVALID_FILTER');
      }
      if (!sort || typeof sort !== 'object' || Array.isArray(sort)) {
        throw new ApplicationError(400, 'INVALID_SORT');
      }
      if (
        !Number.isInteger(page) ||
        page < 0 ||
        !Number.isInteger(perPage) ||
        perPage < 0 ||
        perPage > 10000
      ) {
        throw new ApplicationError(400, 'INVALID_PAGINATION');
      }
      if (
        typeof fields !== 'string' &&
        (!fields || typeof fields !== 'object' || Array.isArray(fields))
      ) {
        throw new ApplicationError(400, 'INVALID_FIELDS');
      }
      const authorizedFilter = policy.authorize('view', filter, scope, messaging.getContext());
      if (!authorizedFilter)
        return {
          listItem   : [],
          totalCount : 0,
        };
      const pageQuery              = model
        .find(authorizedFilter, fields)
        .skip(perPage * page)
        .limit(perPage)
        .sort(sort);
      const countQuery             = model.countDocuments(authorizedFilter);
      const [listItem, totalCount] = await Promise.all([pageQuery, countQuery]);
      return {
        listItem,
        totalCount,
      };
    },

    /** @returns {Promise<number>} Número de coincidencias, sin paginación.
     * @param {Object} filter Filtros de selección que se autorizan antes de consultar.
     * @param {string|symbol} [scope] Alcance solicitado o marcador interno de confianza.
     */
    async count(filter, scope = '') {
      if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
        throw new ApplicationError(400, 'INVALID_FILTER');
      }
      const authorizedFilter = policy.authorize('view', filter, scope, messaging.getContext());
      return authorizedFilter ? model.countDocuments(authorizedFilter) : 0;
    },

    /** @returns {Promise<Object|null>} Documento posterior a los cambios, o null si no existe.
     * @param {Object} filter Filtros de selección que se autorizan antes de consultar.
     * @param {Object} changes Valor de changes utilizado por esta operación.
     * @param {string|symbol} [scope] Alcance solicitado o marcador interno de confianza.
     */
    async update(filter, changes, scope = '') {
      if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
        throw new ApplicationError(400, 'INVALID_FILTER');
      }
      if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
        throw new ApplicationError(400, 'INVALID_CHANGES');
      }
      const authorizedFilter = policy.authorize('update', filter, scope, {
        ...messaging.getContext(),
        changes,
      });
      if (!authorizedFilter) throw new ApplicationError(403, 'FORBIDDEN');
      return model.findOneAndUpdate(authorizedFilter, changes, {
        returnDocument : 'after',
        runValidators  : true,
      });
    },

    /**
     * Revalida la autorización atómicamente al guardar el documento.
     * @returns {Promise<Object>} Documento guardado con su fecha de modificación actualizada.
     * @param {*} document Valor de document utilizado por esta operación.
     * @param {string|symbol} [scope] Alcance solicitado o marcador interno de confianza.
     * @param {*} [operation] Valor de operation utilizado por esta operación.
     */
    async updateItem(document, scope = '', operation = 'update') {
      if (!document || typeof document !== 'object' || Array.isArray(document) || !document._id)
        throw new ApplicationError(400, 'INVALID_DOCUMENT');
      const changes =
        typeof document.toObject === 'function' ? document.toObject() : { ...document };
      delete changes._id;
      delete changes.__v;
      delete changes.save;
      changes.updateDate = Date.now();
      const filter = policy.authorize(operation, { _id: document._id }, scope, {
        ...messaging.getContext(),
        changes,
      });
      if (!filter) throw new ApplicationError(403, 'FORBIDDEN');
      const saved = await model.findOneAndUpdate(filter, changes, {
        returnDocument : 'after',
        runValidators  : true,
      });
      if (!saved) throw new ApplicationError(403, 'FORBIDDEN');
      return saved;
    },

    /**
     * @param {Object} filter Filtro explícito; no se modifica.
     * @param {boolean} [isLogical=true] true marca la baja; false elimina físicamente.
     * @returns {Promise<Object|null>} Documento marcado o eliminado; null si no hubo coincidencia elegible.
     */
    async deleteOne(filter, isLogical = true, scope = '') {
      if (typeof isLogical !== 'boolean') {
        throw new ApplicationError(400, 'INVALID_DELETE_MODE');
      }
      if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
        throw new ApplicationError(400, 'INVALID_FILTER');
      }
      const authorizedFilter = policy.authorize('delete', filter, scope, messaging.getContext());
      if (!authorizedFilter) throw new ApplicationError(403, 'FORBIDDEN');
      if (!isLogical) return model.findOneAndDelete(authorizedFilter);
      return model.findOneAndUpdate(
        { $and: [authorizedFilter, { erased: { $ne: true } }] },
        {
          $set : {
            erased     : true,
            updateDate : Date.now(),
          },
        },
        {
          returnDocument : 'after',
          runValidators  : true,
        },
      );
    },

    /**
     * @param {Object} filter Filtro explícito; no se modifica.
     * @param {boolean} [isLogical=true] true marca bajas; false elimina físicamente.
     * @returns {Promise<{acknowledged: boolean, deletedCount: number}>} Bajas nuevas en modo lógico;
     * DeleteResult del modelo en modo físico.
     */
    async deleteMany(filter, isLogical = true, scope = '') {
      if (typeof isLogical !== 'boolean') {
        throw new ApplicationError(400, 'INVALID_DELETE_MODE');
      }
      if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
        throw new ApplicationError(400, 'INVALID_FILTER');
      }
      const authorizedFilter = policy.authorize('delete', filter, scope, messaging.getContext());
      if (!authorizedFilter) throw new ApplicationError(403, 'FORBIDDEN');
      if (!isLogical) return model.deleteMany(authorizedFilter);
      const result = await model.updateMany(
        { $and: [authorizedFilter, { erased: { $ne: true } }] },
        {
          $set : {
            erased     : true,
            updateDate : Date.now(),
          },
        },
        { runValidators: true },
      );
      return {
        acknowledged : result.acknowledged,
        deletedCount : result.modifiedCount,
      };
    },
    /** Descarga pública: el servidor fija el selector y la condición de visibilidad.
     * @param {Object} filter Filtros de selección que se autorizan antes de consultar.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async getPublicOne(filter) {
      if (!filter || typeof filter !== 'object' || Array.isArray(filter))
        throw new ApplicationError(400, 'INVALID_FILTER');
      return model.findOne(
        policy.authorize(
          'view',
          {
            $and : [
              filter,
              {
                scope   : 'public',
                private : { $ne: true },
              },
            ],
          },
          policy.trustedScopes.guest,
        ),
      );
    },
    /** Contador técnico de una lectura elegible; no admite cambios enviados por el cliente.
     * @param {Object} filter Filtros de selección que se autorizan antes de consultar.
     * @param {string|symbol} [scope] Alcance solicitado o marcador interno de confianza.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async recordAccess(filter, scope = '') {
      const eligible   =
        scope === policy.trustedScopes.guest
          ? {
              $and : [
                filter,
                {
                  scope   : 'public',
                  private : { $ne: true },
                },
              ],
            }
          : filter;
      const authorized = policy.authorize('view', eligible, scope, messaging.getContext());
      if (!authorized) throw new ApplicationError(403, 'FORBIDDEN');
      return model.findOneAndUpdate(
        authorized,
        {
          $inc : { downloads: 1 },
          $set : { lastAccess: Date.now() },
        },
        {
          returnDocument : 'after',
          runValidators  : true,
        },
      );
    },
  };
};
