/** @file Ledger técnico de Files; el dominio invocador autoriza los efectos de negocio. */
'use strict';
const { randomUUID } = require('node:crypto');
/**
 * Compone createFilesStorageRepository con las dependencias recibidas y devuelve su interfaz.
 * @param {Object} options Colaboradores u opciones: model.
 * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
module.exports = function createFilesStorageRepository({ model, clock = Date.now }) {
  let index;
  return {
    /**
     * Ejecuta verifyIndex dentro del flujo de files-storage.repository.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async verifyIndex() {
      index ||= require('../../../library/messaging/indexes')
        .verifyIndexes(
          {
            /**
             * Ejecuta collection dentro del flujo de files-storage.repository.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            collection : () => model.collection,
          },
          {
            DOCUMENTS_FILES : [
              {
                key : {
                  storageState : 1,
                  cleanupUntil : 1,
                  _id          : 1,
                },
              },
              {
                key                     : { storageId: 1 },
                unique                  : true,
                partialFilterExpression : { storageId: { $type: 'string' } },
              },
            ],
          },
        )
        .catch(
          /**
           * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
           * @param {Error} error Fallo recibido por la continuación.
           * @returns {void} Finaliza después de aplicar los efectos de la operación.
           */
          (error) => {
            index = undefined;
            throw error;
          },
        );
      return index;
    },
    /**
     * Ejecuta pendingDeletes dentro del flujo de files-storage.repository.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async pendingDeletes() {
      return model
        .find({
          storageState : 'deleting',
          $or          : [{ cleanupUntil: { $lte: clock() } }, { cleanupUntil: { $exists: false } }],
        })
        .sort({
          cleanupUntil : 1,
          _id          : 1,
        })
        .limit(20)
        .lean();
    },
    /** @returns {Promise<number|undefined>} Vencimiento de un borrado conocido, sin descubrir inventario externo. */
    async nextDeletionAt() {
      const record = await model
        .findOne({ storageState: 'deleting' })
        .sort({
          cleanupUntil : 1,
          _id          : 1,
        })
        .select('+cleanupUntil')
        .lean();
      return record ? record.cleanupUntil || 0 : undefined;
    },
    /** @param {string} storageId Identidad estable. @returns {Promise<Object|null>} Reclamación exclusiva suficiente para el plazo máximo del efecto externo. */
    async claimDelete(storageId) {
      return model
        .findOneAndUpdate(
          {
            storageId,
            storageState : 'deleting',
            $or          : [{ cleanupUntil: { $lte: clock() } }, { cleanupUntil: { $exists: false } }],
          },
          {
            $set : {
              cleanupOwner : randomUUID(),
              cleanupUntil : clock() + 360000,
            },
          },
          {
            returnDocument : 'after',
            runValidators  : true,
          },
        )
        .select('+cleanupOwner +cleanupUntil')
        .lean();
    },
    /** @param {string} storageId Identidad. @param {string} owner Reclamante. @returns {Promise<Object>} Un propietario antiguo no modifica el reintento de otra instancia. */
    retryDelete(storageId, owner) {
      return model.updateOne(
        {
          storageId,
          storageState : 'deleting',
          cleanupOwner : owner,
        },
        {
          $set : {
            cleanupOwner : '',
            cleanupUntil : clock() + 60000,
          },
        },
      );
    },
    /**
     * Ejecuta transaction dentro del flujo de files-storage.repository.
     * @param {*} run Valor de run utilizado por esta operación.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async transaction(run) {
      const session = await model.db.startSession();
      try {
        return await session.withTransaction(
          /**
           * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          () => run(session),
        );
      } finally {
        await session.endSession();
      }
    },
    /**
     * Obtiene el valor solicitado.
     * @param {*} storageId Valor de storageId utilizado por esta operación.
     * @param {Object} session Sesión que agrupa las operaciones de persistencia.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async get(storageId, session) {
      const query = model.findOne({ storageId }).select('+cleanupOwner +cleanupUntil');
      return (session ? query.session(session) : query).lean();
    },
    /**
     * Ejecuta insert dentro del flujo de files-storage.repository.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @param {Object} session Sesión que agrupa las operaciones de persistencia.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async insert(input, session) {
      return model.create([input], { session });
    },
    /**
     * Actualiza los campos autorizados del registro.
     * @param {*} storageId Valor de storageId utilizado por esta operación.
     * @param {Object} changes Valor de changes utilizado por esta operación.
     * @param {Object} session Sesión que agrupa las operaciones de persistencia.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async update(storageId, changes, session) {
      return model
        .findOneAndUpdate(
          { storageId },
          { $set: changes },
          {
            returnDocument : 'after',
            runValidators  : true,
            ...(session ? { session } : {}),
          },
        )
        .lean();
    },
    /**
     * Ejecuta transition dentro del flujo de files-storage.repository.
     * @param {*} storageId Valor de storageId utilizado por esta operación.
     * @param {*} from Valor de from utilizado por esta operación.
     * @param {*} state Valor de state utilizado por esta operación.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async transition(storageId, from, state) {
      return model
        .findOneAndUpdate(
          {
            storageId,
            storageState : { $in: from },
          },
          { $set: { storageState: state } },
          {
            returnDocument : 'after',
            runValidators  : true,
          },
        )
        .lean();
    },
  };
};
