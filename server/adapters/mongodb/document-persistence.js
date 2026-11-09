/** @file Semántica MongoDB encapsulada para los casos de uso documentales. */
'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash }        = require('node:crypto');
const { ApplicationError }  = require('../../shared/application-error');
/**
 * Encapsula identificadores, verificación de transacciones y clasificación de errores MongoDB para Documents.
 * @param {Object} options Colaboradores u opciones: mongoose, connection.
 * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function documentPersistence({ mongoose, connection }) {
  const local = new AsyncLocalStorage();
  mongoose.set('transactionAsyncLocalStorage', true);
  return {
    /** @returns {Object|undefined} Sesión compartida por la operación actual. */
    current     : () => local.getStore(),
    /** @param {*} value Identidad y contenido. @returns {string} Huella canónica. */
    hash(value) {
      /** @param {*} item Valor privado. @returns {*} Orden canónico. */
      function stable(item) {
        if (Array.isArray(item)) return item.map(stable);
        if (!item || typeof item !== 'object') return item;
        const result = {};
        for (const key of Object.keys(item).sort())
          if (item[key] !== undefined) result[key] = stable(item[key]);
        return result;
      }
      return createHash('sha256')
        .update(JSON.stringify(stable(value)))
        .digest('hex');
    },
    /** @param {string} key Identidad de intención. @returns {Promise<Object|null>} Recibo de resultado confirmado. */
    receiptRead : (key) =>
      connection.db
        .collection('DOCUMENTS_OPERATION_RECEIPTS')
        .findOne({ _id: key }, { session: local.getStore() }),
    /** @param {Object} receipt Resultado y autorización. @returns {Promise<Object>} Recibo atómico con la mutación. */
    receiptInsert(receipt) {
      if (!local.getStore()) throw new ApplicationError(503, 'DOCUMENT_TRANSACTIONS_REQUIRED');
      return connection.db
        .collection('DOCUMENTS_OPERATION_RECEIPTS')
        .insertOne({ ...receipt }, { session: local.getStore() });
    },
    ids         : {
      /**
       * Interpreta la entrada y devuelve su representación normalizada.
       * @param {*} value Valor de value utilizado por esta operación.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      parse  : (value) => new mongoose.Types.ObjectId(value),

      /**
       * Crea el registro y devuelve el resultado de la operación.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      create : () => new mongoose.Types.ObjectId(),
    },
    /**
     * Ejecuta run dentro del flujo de document-persistence.
     * @param {Function} work Valor de work utilizado por esta operación.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async run(work) {
      try {
        if (local.getStore()) return work(local.getStore());
        return await connection.transaction(
          /** @param {Object} session Sesión MongoDB. @returns {Promise<Object>} Todos los repositorios comparten la transacción exterior. */ (
            session,
          ) =>
            local.run(
              session,
              /** @returns {Promise<Object>} Resultado de aplicación. */ () => work(session),
            ),
          { readConcern: { level: 'snapshot' } },
        );
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        if (
          error.hasErrorLabel?.('UnknownTransactionCommitResult') ||
          error.errorLabels?.includes('UnknownTransactionCommitResult') ||
          /Mongo(Network|ServerSelection)/.test(error.name || '')
        )
          throw new ApplicationError(503, 'DOCUMENT_WRITE_UNCERTAIN', {
            cause     : error,
            uncertain : true,
          });
        if (error.code === 11000) throw new ApplicationError(409, 'DOCUMENT_ALREADY_EXISTS');
        if (error.code === 20) throw new ApplicationError(503, 'DOCUMENT_TRANSACTIONS_REQUIRED');
        throw error;
      }
    },
    /**
     * Ejecuta verify dentro del flujo de document-persistence.
     * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
     */
    async verify() {
      const hello = await connection.db.admin().command({ hello: 1 });
      if ((!hello.setName && hello.msg !== 'isdbgrid') || !hello.logicalSessionTimeoutMinutes)
        throw new ApplicationError(503, 'DOCUMENT_TRANSACTIONS_REQUIRED');
    },
  };
}
module.exports = { documentPersistence };
