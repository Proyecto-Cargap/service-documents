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
      workspace        : {
        type     : String,
        default  : 'allWorkspaces',
        required : true,
      },
      /**
       * Autor del registro; permanece inmutable.
       */
      userCreate       : {
        type      : String,
        default   : undefined,
        required  : true,
        immutable : true,
      },
      /**
       * Responsable asignado; vacío cuando no corresponde.
       */
      userAssigned     : {
        type     : String,
        default  : '',
        required : false,
      },
      /**
       * Fecha de creación en milisegundos.
       */
      creationDate     : {
        type     : Number,
        default  : Date.now,
        required : false,
      },
      /**
       * Fecha de última modificación en milisegundos.
       */
      updateDate       : {
        type     : Number,
        default  : Date.now,
        required : false,
      },
      /**
       * Marca explícita de baja lógica.
       */
      erased           : {
        type     : Boolean,
        default  : false,
        required : false,
      },
      /**
       * Identidad de la transacción que originó el registro.
       */
      idTransaction    : {
        type     : String,
        default  : '',
        required : false,
      },
      /**
       * Raíz autorizada que delimita toda consulta del nodo.
       */
      repositoryId     : {
        type     : Schema.Types.ObjectId,
        default  : undefined,
        required : true,
      },
      /**
       * Carpeta padre; null identifica la raíz.
       */
      parentId         : {
        type     : Schema.Types.ObjectId,
        default  : null,
        required : false,
      },
      /**
       * Nombre NFC sin separadores ni controles.
       */
      name             : {
        type     : String,
        default  : undefined,
        required : true,
      },
      /**
       * Clave exacta y sensible a mayúsculas del nombre normalizado.
       */
      nameKey          : {
        type     : String,
        default  : undefined,
        required : true,
      },
      /**
       * Archivo o carpeta; las carpetas no generan objetos S3.
       */
      type             : {
        type     : String,
        default  : undefined,
        required : true,
      },
      /**
       * Estado active, uploading o trashed; sólo active aparece en el explorador.
       */
      state            : {
        type     : String,
        default  : 'active',
        required : false,
      },
      /**
       * Entrada principal del subárbol enviado a la papelera.
       */
      trashRootId      : {
        type     : Schema.Types.ObjectId,
        default  : null,
        required : false,
      },
      /**
       * Fecha de envío a papelera en milisegundos.
       */
      trashedAt        : {
        type     : Number,
        default  : 0,
        required : false,
      },
      /**
       * Vencimiento capturado a partir de settings al enviar a papelera.
       */
      purgeAfter       : {
        type     : Number,
        default  : 0,
        required : false,
      },
      /**
       * Bytes del archivo activo; cero para carpetas.
       */
      size             : {
        type     : Number,
        default  : 0,
        required : false,
        min      : 0,
      },
      /**
       * Tipo MIME declarado para la versión activa.
       */
      mimeType         : {
        type     : String,
        default  : 'application/octet-stream',
        required : false,
      },
      /**
       * Referencia privada opaca a bytes S3; nunca se expone al consumidor.
       */
      storageKey       : {
        type     : String,
        default  : '',
        required : false,
      },
      /** Huella del contenido confirmado; null para archivos anteriores a su incorporación. */
      sha256           : {
        type    : String,
        default : null,
        match   : /^[a-f0-9]{64}$/,
      },
      /**
       * Versión de metadatos para comparación optimista.
       */
      revision         : {
        type     : Number,
        default  : 1,
        required : false,
        min      : 0,
      },
      /**
       * Operación de carga que posee la reserva del nodo.
       */
      pendingOperation : {
        type     : Schema.Types.ObjectId,
        default  : null,
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
      repositoryId : 1,
      parentId     : 1,
      nameKey      : 1,
    },
    {
      unique                  : true,
      name                    : 'documents_entry_live_name',
      partialFilterExpression : { state: { $in: ['active', 'uploading'] } },
    },
  );
  schema.index(
    {
      repositoryId : 1,
      parentId     : 1,
      state        : 1,
      name         : 1,
    },
    { name: 'documents_entry_list' },
  );
  schema.index(
    {
      repositoryId : 1,
      state        : 1,
      _id          : 1,
    },
    { name: 'documents_entry_manifest' },
  );
  schema.path('type').enum(...['file', 'folder']);
  schema.index(
    {
      state       : 1,
      purgeAfter  : 1,
      trashRootId : 1,
    },
    { name: 'documents_entry_trash_expiry' },
  );
  schema.path('state').enum(...['active', 'uploading', 'trashed']);
  schema.pre(
    'validate',

    /**
     * Comprueba las condiciones de validateContent antes de continuar.
     * @returns {void} Finaliza después de aplicar los efectos de la operación.
     */
    function validateContent() {
      if (this.type === 'folder' && (this.size !== 0 || this.storageKey))
        this.invalidate('storageKey', 'DOCUMENT_FOLDER_HAS_NO_CONTENT');
      if (this.type === 'file' && this.state !== 'uploading' && !this.storageKey)
        this.invalidate('storageKey', 'DOCUMENT_CONTENT_REFERENCE_REQUIRED');
      if (
        typeof this.name !== 'string' ||
        this.name !== this.nameKey ||
        this.name !== this.name.normalize('NFC').trim() ||
        /[/\\\p{Cc}]/u.test(this.name)
      )
        this.invalidate('name', 'INVALID_DOCUMENT_NAME');
    },
  );
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
    mongoose.models?.DOCUMENTS_ENTRIES ||
    mongoose.model('DOCUMENTS_ENTRIES', schema, 'DOCUMENTS_ENTRIES')
  );
};
