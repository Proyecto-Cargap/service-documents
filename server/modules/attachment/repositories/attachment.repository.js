/** @file Ledger privado de almacenamiento, separado del catálogo general de Documents. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
/**
 * Construye acceso a metadatos internos con modelo y conexión inyectados.
 * @param {Object} dependencies Modelo Mongoose y conexión transaccional.
 * @returns {Object} Operaciones técnicas invocadas después de verificar el origen RPC.
 */
function createAttachmentRepository({ model, connection }) {
  /**
   * Comprueba los metadatos canónicos antes de autorizar operaciones sobre almacenamiento y cuota.
   * @param {Object|null} row Registro persistido o ausencia de registro.
   * @returns {Object|null} Metadatos explícitos del registro o ausencia real.
   * @throws {ApplicationError} INVALID_ATTACHMENT_RECORD cuando faltan metadatos obligatorios; no infiere propietarios ni claves.
   */
  function attachmentRecord(row) {
    if (!row) return null;
    if (
      ['_id', 'originService', 'resourceType', 'resourceCode', 'storageKey', 'digest', 'mime'].some(
        /** @param {string} field Metadato obligatorio de identidad, pertenencia o contenido.
         * @returns {boolean} Identifica un valor ausente o vacío.
         */
        (field) => typeof row[field] !== 'string' || !row[field].trim(),
      ) ||
      !Number.isSafeInteger(row.size) ||
      row.size <= 0 ||
      !Number.isSafeInteger(row.creationDate) ||
      row.creationDate < 0 ||
      !['uploading', 'ready', 'deleting', 'deleted'].includes(row.state)
    )
      throw new ApplicationError(500, 'INVALID_ATTACHMENT_RECORD');
    return {
      _id           : row._id,
      originService : row.originService,
      resourceType  : row.resourceType,
      resourceCode  : row.resourceCode,
      storageKey    : row.storageKey,
      digest        : row.digest,
      size          : row.size,
      mime          : row.mime,
      state         : row.state,
      creationDate  : row.creationDate,
      ...(row.deletionDate === undefined ? {} : { deletionDate: row.deletionDate }),
    };
  }

  return {
    /**
     * Consulta una operación por su código inmutable.
     * @param {*} filter Filtro construido por el caso de uso autorizado.
     * @returns {*} Resultado de la operación; los errores se propagan al llamador.
     */
    async findOne(filter) {
      return attachmentRecord(await model.findOne(filter).lean());
    },
    /**
     * Registra la reserva de cuota en la misma transacción que el ledger.
     * @param {*} input Datos normalizados de entrada.
     * @param {*} options Opciones de ejecución o transacción.
     * @returns {*} Resultado de la operación; los errores se propagan al llamador.
     */
    async insertOne(input, options) {
      return attachmentRecord((await model.create([input], options))[0].toObject());
    },
    /**
     * Cambia un estado esperado sin sobrescribir operaciones concurrentes.
     * @param {*} filter Filtro construido por el caso de uso autorizado.
     * @param {*} changes Cambios normalizados que se aplican al registro.
     * @param {*} options Opciones de ejecución o transacción.
     * @returns {*} Resultado de la operación; los errores se propagan al llamador.
     */
    updateOne(filter, changes, options) {
      return model.updateOne(filter, changes, {
        ...options,
        runValidators : true,
      });
    },
    /**
     * Reclama el archivo para borrado y devuelve su tamaño reservado.
     * @param {*} filter Filtro construido por el caso de uso autorizado.
     * @param {*} changes Cambios normalizados que se aplican al registro.
     * @param {*} options Opciones de ejecución o transacción.
     * @returns {*} Resultado de la operación; los errores se propagan al llamador.
     */
    async findOneAndUpdate(filter, changes, options) {
      const record = await model
        .findOneAndUpdate(filter, changes, {
          ...options,
          runValidators  : true,
          returnDocument : 'after',
        })
        .lean();
      return attachmentRecord(record);
    },
    /**
     * Ejecuta una unidad atómica para cuota y metadatos.
     * @param {*} operation Operación controlada por la composición del servidor.
     * @returns {*} Resultado de la operación; los errores se propagan al llamador.
     */
    async transaction(operation) {
      const session = await connection.startSession();
      try {
        return await session.withTransaction(
          /**
           * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          () => operation(session),
        );
      } finally {
        await session.endSession();
      }
    },
  };
}
module.exports = createAttachmentRepository;
