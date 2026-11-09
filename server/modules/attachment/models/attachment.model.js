/**
 * @file Ledger privado de adjuntos; los registros no pertenecen al catálogo general de archivos.
 */
'use strict';
/**
 * Construye el modelo técnico de almacenamiento privado de recursos.
 * @param {Object} dependencies Mongoose inyectado desde composición.
 * @returns {Object} Modelo con código UUID y cuota verificable.
 */
function createAttachmentModel({ mongoose }) {
  const schema = new mongoose.Schema(
    {
      /**
       * Código UUID del adjunto, único e idempotente.
       */
      _id           : {
        type     : String,
        default  : undefined,
        required : true,
      },
      originService : {
        type     : String,
        required : true,
      },
      resourceType  : {
        type     : String,
        required : true,
      },
      resourceCode  : {
        type     : String,
        required : true,
      },
      storageKey    : {
        type     : String,
        required : true,
      },
      /**
       * SHA-256 del contenido para impedir reintentos con bytes distintos.
       */
      digest        : {
        type     : String,
        default  : undefined,
        required : true,
      },
      /**
       * Bytes reservados en la cuota compartida.
       */
      size          : {
        type     : Number,
        default  : undefined,
        required : true,
      },
      /**
       * Tipo de imagen o audio acreditado por contenido, o descarga binaria segura.
       */
      mime          : {
        type     : String,
        default  : undefined,
        required : true,
      },
      /**
       * Estado uploading, ready, deleting o deleted.
       */
      state         : {
        type     : String,
        default  : undefined,
        required : true,
      },
      /**
       * Fecha inicial de la operación de almacenamiento.
       */
      creationDate  : {
        type     : Number,
        default  : undefined,
        required : true,
      },
      /**
       * Fecha de liberación confirmada de la cuota.
       */
      deletionDate  : {
        type     : Number,
        default  : undefined,
        required : false,
      },
    },
    { versionKey: false },
  );
  return (
    mongoose.models.COMMUNICATION_STORAGE ||
    mongoose.model('COMMUNICATION_STORAGE', schema, 'COMMUNICATION_STORAGE')
  );
}
module.exports = createAttachmentModel;
