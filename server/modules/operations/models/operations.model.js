/**
 * @file Esquema documental dedicado; conserva metadatos de acceso e índices propios.
 */
'use strict';
/**
 * Compone createModel con las dependencias recibidas y devuelve su interfaz.
 * @param {Object} options Colaboradores u opciones: mongoose.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
module.exports = function createModel({ mongoose }) {
  const Schema = mongoose.Schema;
  const schema = new Schema(
    {
      /**
       * Espacio técnico de acceso; allWorkspaces mantiene las preferencias independientes del selector.
       */
      /** Intención delegada y evidencia suficiente para recuperar sin repetir PUT. */
      requestKey         : {
        type    : String,
        default : undefined,
      },
      requestFingerprint : {
        type    : String,
        default : undefined,
      },
      delegation         : {
        type    : Schema.Types.Mixed,
        default : undefined,
      },
      executionWorkspace : {
        type    : String,
        default : undefined,
      },
      result             : {
        type    : Schema.Types.Mixed,
        default : undefined,
      },
      workspace          : {
        type     : String,
        default  : 'allWorkspaces',
        required : true,
      },
      /**
       * Autor del registro; permanece inmutable.
       */
      userCreate         : {
        type      : String,
        default   : undefined,
        required  : true,
        immutable : true,
      },
      /**
       * Responsable asignado; vacío cuando no corresponde.
       */
      userAssigned       : {
        type     : String,
        default  : '',
        required : false,
      },
      /**
       * Fecha de creación en milisegundos.
       */
      creationDate       : {
        type     : Number,
        default  : Date.now,
        required : false,
      },
      /**
       * Fecha de última modificación en milisegundos.
       */
      updateDate         : {
        type     : Number,
        default  : Date.now,
        required : false,
      },
      /**
       * Marca explícita de baja lógica.
       */
      erased             : {
        type     : Boolean,
        default  : false,
        required : false,
      },
      /**
       * Identidad de la transacción que originó el registro.
       */
      idTransaction      : {
        type     : String,
        default  : '',
        required : false,
      },
      /**
       * Upload o cleanup de claves conocidas; no descubre inventario S3.
       */
      kind               : {
        type     : String,
        default  : undefined,
        required : true,
      },
      /**
       * Pending, cleanup, abandoned, complete o failed para recuperación idempotente.
       */
      state              : {
        type     : String,
        default  : 'pending',
        required : false,
      },
      /**
       * Raíz que posee la reserva y cuota.
       */
      repositoryId       : {
        type     : Schema.Types.ObjectId,
        default  : undefined,
        required : true,
      },
      /**
       * Entrada reservada por una carga.
       */
      entryId            : {
        type     : Schema.Types.ObjectId,
        default  : null,
        required : false,
      },
      /**
       * Padre capturado al reservar la carga.
       */
      parentId           : {
        type     : Schema.Types.ObjectId,
        default  : null,
        required : false,
      },
      /**
       * Nombre normalizado capturado para la versión.
       */
      name               : {
        type     : String,
        default  : '',
        required : false,
      },
      /**
       * Clave S3 única de la nueva versión.
       */
      storageKey         : {
        type     : String,
        default  : '',
        required : false,
      },
      /**
       * Versión reemplazada; sólo se elimina después del commit.
       */
      oldStorageKey      : {
        type     : String,
        default  : '',
        required : false,
      },
      /**
       * Tamaño exacto de bytes esperados.
       */
      size               : {
        type     : Number,
        default  : 0,
        required : false,
        min      : 0,
      },
      /**
       * Tamaño activo previo para ajustar la cuota.
       */
      oldSize            : {
        type     : Number,
        default  : 0,
        required : false,
        min      : 0,
      },
      /**
       * Reserva de capacidad que debe liberarse exactamente una vez.
       */
      reservedSpace      : {
        type     : Number,
        default  : 0,
        required : false,
        min      : 0,
      },
      /**
       * Tipo MIME esperado del contenido.
       */
      mimeType           : {
        type     : String,
        default  : 'application/octet-stream',
        required : false,
      },
      /**
       * SHA256 de bytes para resolver una escritura incierta con HEAD.
       */
      checksum           : {
        type     : String,
        default  : '',
        required : false,
      },
      /**
       * Revisión de entrada capturada antes de S3.
       */
      expectedRevision   : {
        type     : Number,
        default  : 0,
        required : false,
        min      : 0,
      },
      /**
       * Distingue nueva reserva de reemplazo de versión.
       */
      isNewEntry         : {
        type     : Boolean,
        default  : false,
        required : false,
      },
      /**
       * Claves conocidas pendientes de limpieza; nunca prefijos de borrado.
       */
      keys               : {
        type     : [String],
        default  : [],
        required : false,
      },
      /**
       * Temporal validado que recuperación puede limpiar.
       */
      tempFilePath       : {
        type     : String,
        default  : '',
        required : false,
      },
      /**
       * Expiración de posesión para impedir recuperación mientras PUT continúa.
       */
      leaseUntil         : {
        type     : Number,
        default  : 0,
        required : false,
        min      : 0,
      },
      /**
       * Ventana de asentamiento de PUT antes de liberar una reserva sin objeto visible.
       */
      settleUntil        : {
        type     : Number,
        default  : 0,
        required : false,
        min      : 0,
      },
      /**
       * Token del worker que reclama la recuperación.
       */
      leaseToken         : {
        type     : String,
        default  : '',
        required : false,
      },
    },
    {
      versionKey : false,
      strict     : true,
      autoIndex  : false,
      autoCreate : false,
    },
  );
  schema.index(
    {
      state      : 1,
      leaseUntil : 1,
    },
    { name: 'documents_operation_recovery' },
  );
  schema.path('kind').enum(...['upload', 'cleanup']);
  schema.path('state').enum(...['pending', 'cleanup', 'abandoned', 'complete', 'failed']);
  schema.path('userAssigned').validate(
    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {*} value Valor de value utilizado por esta operación.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    (value) => typeof value === 'string',
    'ACCESS_METADATA_REQUIRED',
  );
  schema.index({
    workspace  : 1,
    userCreate : 1,
  });
  schema.index({
    workspace    : 1,
    userAssigned : 1,
  });
  return (
    mongoose.models?.DOCUMENTS_OPERATIONS ||
    mongoose.model('DOCUMENTS_OPERATIONS', schema, 'DOCUMENTS_OPERATIONS')
  );
};
