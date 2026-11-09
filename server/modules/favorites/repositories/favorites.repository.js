/** @file Persistencia local documental; modelo y sesión se inyectan sin efectos al construir. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
const policy               = require('../policies/favorites.policy');
/**
 * Compone createFavoritesRepository con las dependencias recibidas y devuelve su interfaz.
 * @param {Object} options Colaboradores u opciones: model, messaging.
 * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
module.exports = function createFavoritesRepository({
  model,
  messaging,
  /** @returns {Object|undefined} Sin transacción exterior por defecto. */
  getSession = () => undefined,
}) {
  /**
   * Comprueba permisos y delimita el alcance de la operación.
   * @param {string} action Valor de action utilizado por esta operación.
   * @param {Object} filter Filtros de selección que se autorizan antes de consultar.
   * @param {string|symbol} scope Alcance solicitado o marcador interno de confianza.
   * @param {Object} changes Valor de changes utilizado por esta operación.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  function authorize(action, filter, scope, changes) {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter))
      throw new ApplicationError(400, 'INVALID_FILTER');
    const result = policy.authorize(action, filter, scope, {
      ...messaging.getContext(),
      changes,
    });
    if (!result && action !== 'view') throw new ApplicationError(403, 'FORBIDDEN');
    return result;
  }
  return {
    /** Lee favoritos sólo para las entradas de una página y el propietario acreditado.
     * @param {string} userCode Código del usuario relacionado con la operación.
     * @param {*} entryIds Valor de entryIds utilizado por esta operación.
     * @param {string|symbol} scope Alcance solicitado o marcador interno de confianza.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async forEntries(userCode, entryIds, scope) {
      if (
        typeof userCode !== 'string' ||
        !userCode ||
        !Array.isArray(entryIds) ||
        entryIds.length > 100
      )
        throw new ApplicationError(400, 'INVALID_FAVORITE_BATCH');
      if (!entryIds.length) return [];
      const filter = authorize(
        'view',
        {
          userCreate : userCode,
          entryId    : { $in: entryIds },
          erased     : false,
        },
        scope,
      );
      return filter ? model.find(filter, { entryId: 1 }).limit(100).lean() : [];
    },
    /** Aplica ACL y estado de las entradas antes del facet de página y total.
     * @param {Object} filter Filtros de selección que se autorizan antes de consultar.
     * @param {*} rootFilter Valor de rootFilter utilizado por esta operación.
     * @param {*} entryFilter Valor de entryFilter utilizado por esta operación.
     * @param {*} sort Valor de sort utilizado por esta operación.
     * @param {number} page Índice de la página según el contrato de esta operación.
     * @param {number} perPage Cantidad máxima de elementos por página.
     * @param {string|symbol} scope Alcance solicitado o marcador interno de confianza.
     * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async getJoinedList(filter, rootFilter, entryFilter, sort, page, perPage, scope) {
      const authorized = authorize('view', filter, scope);
      if (!authorized)
        return {
          listItem   : [],
          totalCount : 0,
        };
      if (
        !Number.isInteger(page) ||
        page < 0 ||
        !Number.isInteger(perPage) ||
        perPage < 0 ||
        perPage > 10000
      )
        throw new ApplicationError(400, 'INVALID_PAGINATION');
      const list = [{ $sort: sort }, { $skip: page * perPage }];
      if (perPage) list.push({ $limit: perPage });
      const rows = await model.aggregate([
        { $match: authorized },
        {
          $lookup : {
            from         : 'DOCUMENTS_ENTRIES',
            localField   : 'entryId',
            foreignField : '_id',
            as           : 'entry',
          },
        },
        { $unwind: '$entry' },
        { $replaceRoot: { newRoot: '$entry' } },
        { $match: entryFilter },
        {
          $lookup : {
            from     : 'DOCUMENTS_REPOSITORIES',
            let      : { repositoryId: '$repositoryId' },
            pipeline : [
              { $match: rootFilter },
              { $match: { $expr: { $eq: ['$_id', '$$repositoryId'] } } },
            ],
            as       : 'repository',
          },
        },
        { $unwind: '$repository' },
        {
          $facet : {
            listItem : list,
            count    : [{ $count: 'total' }],
          },
        },
      ]);
      return {
        listItem   : rows[0]?.listItem || [],
        totalCount : rows[0]?.count[0]?.total || 0,
      };
    },
    /**
     * Ejecuta checkIndexes dentro del flujo de favorites.repository.
     * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
     */
    async checkIndexes() {
      const actual = await model.collection.indexes().catch(
        /**
         * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
         * @returns {Array<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        () => [],
      );
      for (const [key, options] of model.schema.indexes()) {
        const found = actual.find(
          /**
           * Determina si el elemento corresponde al recurso buscado.
           * @param {*} item Valor de item utilizado por esta operación.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          (item) =>
            item.name === options.name ||
            (!options.name && JSON.stringify(item.key) === JSON.stringify(key)),
        );
        if (
          !found ||
          JSON.stringify(found.key) !== JSON.stringify(key) ||
          !!found.unique !== !!options.unique
        )
          throw new ApplicationError(503, 'DOCUMENT_INDEXES_REQUIRED');
      }
    },
    /**
     * Crea el registro y devuelve el resultado de la operación.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @param {string|symbol} [scope] Alcance solicitado o marcador interno de confianza.
     * @param {Object} [options] Opciones que delimitan el comportamiento de la operación.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async create(input, scope = '', options = {}) {
      const data = authorize('create', input, scope);
      const item = new model(data);
      return item.save({ session: options.session || getSession() });
    },
    /**
     * Obtiene el registro que cumple los filtros autorizados.
     * @param {Object} filter Filtros de selección que se autorizan antes de consultar.
     * @param {string|symbol} [scope] Alcance solicitado o marcador interno de confianza.
     * @param {*} [operation] Valor de operation utilizado por esta operación.
     * @param {Object} changes Valor de changes utilizado por esta operación.
     * @param {Object} [options] Opciones que delimitan el comportamiento de la operación.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async getOne(filter, scope = '', operation = 'view', changes, options = {}) {
      const authorized = authorize(operation, filter, scope, changes);
      if (!authorized) return null;
      return model.findOne(authorized).session(options.session || getSession() || null);
    },
    /**
     * Consulta una página de registros autorizados.
     * @param {Object} filter Filtros de selección que se autorizan antes de consultar.
     * @param {*} [sort] Valor de sort utilizado por esta operación.
     * @param {number} [page] Índice de la página según el contrato de esta operación.
     * @param {number} [perPage] Cantidad máxima de elementos por página.
     * @param {*} [fields] Valor de fields utilizado por esta operación.
     * @param {string|symbol} [scope] Alcance solicitado o marcador interno de confianza.
     * @param {Object} [options] Opciones que delimitan el comportamiento de la operación.
     * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async getList(
      filter,
      sort = {},
      page = 0,
      perPage = 20,
      fields = '',
      scope = '',
      options = {},
    ) {
      if (
        !Number.isInteger(page) ||
        page < 0 ||
        !Number.isInteger(perPage) ||
        perPage < 0 ||
        perPage > 10000
      )
        throw new ApplicationError(400, 'INVALID_PAGINATION');
      if (!sort || typeof sort !== 'object' || Array.isArray(sort))
        throw new ApplicationError(400, 'INVALID_SORT');
      if (
        typeof fields !== 'string' &&
        (!fields || typeof fields !== 'object' || Array.isArray(fields))
      )
        throw new ApplicationError(400, 'INVALID_FIELDS');
      const authorized = authorize('view', filter, scope);
      if (!authorized)
        return {
          listItem   : [],
          totalCount : 0,
        };
      const pageQuery              = model
        .find(authorized, fields)
        .sort(sort)
        .skip(page * perPage)
        .limit(perPage)
        .session(options.session || getSession() || null);
      const countQuery             = model
        .countDocuments(authorized)
        .session(options.session || getSession() || null);
      const [listItem, totalCount] =
        options.session || getSession()
          ? [await pageQuery, await countQuery]
          : await Promise.all([pageQuery, countQuery]);
      return {
        listItem,
        totalCount,
      };
    },
    /**
     * Ejecuta count dentro del flujo de favorites.repository.
     * @param {Object} filter Filtros de selección que se autorizan antes de consultar.
     * @param {string|symbol} [scope] Alcance solicitado o marcador interno de confianza.
     * @param {Object} [options] Opciones que delimitan el comportamiento de la operación.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async count(filter, scope = '', options = {}) {
      const authorized = authorize('view', filter, scope);
      return authorized
        ? model.countDocuments(authorized).session(options.session || getSession() || null)
        : 0;
    },
    /**
     * Actualiza los campos autorizados del registro.
     * @param {Object} filter Filtros de selección que se autorizan antes de consultar.
     * @param {Object} changes Valor de changes utilizado por esta operación.
     * @param {string|symbol} [scope] Alcance solicitado o marcador interno de confianza.
     * @param {Object} [options] Opciones que delimitan el comportamiento de la operación.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async update(filter, changes, scope = '', options = {}) {
      if (!changes || typeof changes !== 'object' || Array.isArray(changes))
        throw new ApplicationError(400, 'INVALID_CHANGES');
      return model.findOneAndUpdate(authorize('update', filter, scope, changes), changes, {
        returnDocument : 'after',
        runValidators  : true,
        session        : options.session || getSession(),
      });
    },
    /** Revalida el alcance y guarda los cambios atómicamente con la sesión del caso de uso.
     * @param {*} document Valor de document utilizado por esta operación.
     * @param {string|symbol} [scope] Alcance solicitado o marcador interno de confianza.
     * @param {*} [operation] Valor de operation utilizado por esta operación.
     * @param {Object} [options] Opciones que delimitan el comportamiento de la operación.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async updateItem(document, scope = '', operation = 'update', options = {}) {
      if (!document || typeof document !== 'object' || Array.isArray(document) || !document._id)
        throw new ApplicationError(400, 'INVALID_DOCUMENT');
      const changes =
        typeof document.toObject === 'function' ? document.toObject() : { ...document };
      delete changes._id;
      delete changes.__v;
      delete changes.save;
      changes.updateDate = Date.now();
      const filter = authorize(operation, { _id: document._id }, scope, changes);
      if (!filter) throw new ApplicationError(403, 'FORBIDDEN');
      const saved = await model.findOneAndUpdate(filter, changes, {
        returnDocument : 'after',
        runValidators  : true,
        session        : options.session || getSession(),
      });
      if (!saved) throw new ApplicationError(403, 'FORBIDDEN');
      return saved;
    },
    /**
     * Ejecuta deleteOne dentro del flujo de favorites.repository.
     * @param {Object} filter Filtros de selección que se autorizan antes de consultar.
     * @param {*} [isLogical] Valor de isLogical utilizado por esta operación.
     * @param {string|symbol} [scope] Alcance solicitado o marcador interno de confianza.
     * @param {Object} [options] Opciones que delimitan el comportamiento de la operación.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async deleteOne(filter, isLogical = true, scope = '', options = {}) {
      if (typeof isLogical !== 'boolean') throw new ApplicationError(400, 'INVALID_DELETE_MODE');
      const authorized = authorize('delete', filter, scope);
      if (!isLogical)
        return model.findOneAndDelete(authorized, { session: options.session || getSession() });
      return model.findOneAndUpdate(
        { $and: [authorized, { erased: { $ne: true } }] },
        {
          $set : {
            erased     : true,
            updateDate : Date.now(),
          },
        },
        {
          returnDocument : 'after',
          runValidators  : true,
          session        : options.session || getSession(),
        },
      );
    },
    /**
     * Ejecuta deleteMany dentro del flujo de favorites.repository.
     * @param {Object} filter Filtros de selección que se autorizan antes de consultar.
     * @param {*} [isLogical] Valor de isLogical utilizado por esta operación.
     * @param {string|symbol} [scope] Alcance solicitado o marcador interno de confianza.
     * @param {Object} [options] Opciones que delimitan el comportamiento de la operación.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async deleteMany(filter, isLogical = true, scope = '', options = {}) {
      if (typeof isLogical !== 'boolean') throw new ApplicationError(400, 'INVALID_DELETE_MODE');
      const authorized = authorize('delete', filter, scope);
      if (!isLogical)
        return model.deleteMany(authorized, { session: options.session || getSession() });
      const result = await model.updateMany(
        { $and: [authorized, { erased: { $ne: true } }] },
        {
          $set : {
            erased     : true,
            updateDate : Date.now(),
          },
        },
        {
          runValidators : true,
          session       : options.session || getSession(),
        },
      );
      return {
        acknowledged : result.acknowledged,
        deletedCount : result.modifiedCount,
      };
    },
    /**
     * Ejecuta updateMany dentro del flujo de favorites.repository.
     * @param {Object} filter Filtros de selección que se autorizan antes de consultar.
     * @param {Object} changes Valor de changes utilizado por esta operación.
     * @param {string|symbol} [scope] Alcance solicitado o marcador interno de confianza.
     * @param {Object} [options] Opciones que delimitan el comportamiento de la operación.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async updateMany(filter, changes, scope = '', options = {}) {
      if (!changes || typeof changes !== 'object' || Array.isArray(changes))
        throw new ApplicationError(400, 'INVALID_CHANGES');
      return model.updateMany(authorize('update', filter, scope, changes), changes, {
        runValidators : true,
        session       : options.session || getSession(),
      });
    },
  };
};
