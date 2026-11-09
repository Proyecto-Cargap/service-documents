/**
 * Compone createFilesModel con las dependencias recibidas y devuelve su interfaz.
 * @param {Object} dependencies Colaboradores explícitos de la composición.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
module.exports = function createFilesModel(dependencies) {
  /**
   * @file Esquema Mongoose de archivos: campos, valores predeterminados y reglas de persistencia.
   * Define la estructura utilizada al crear y consultar documentos de este recurso.
   */
  const mongoose = dependencies.mongoose;
  const Schema   = mongoose.Schema;
  const schema   = new Schema({
    /**
     * Espacio de trabajo del registro; allWorkspaces identifica recursos compartidos.
     */
    workspace     : {
      type     : String,
      default  : undefined,
      required : true,
    },
    /**
     * Código del usuario autor; permanece inmutable después de crear el registro.
     */
    userCreate    : {
      type      : String,
      default   : undefined,
      required  : false,
      immutable : true,
    },
    /**
     * Código del usuario responsable; vacío cuando no existe una asignación.
     */
    userAssigned  : {
      type     : String,
      default  : undefined,
      required : false,
    },
    /**
     * Nombre único del archivo almacenado.
     */
    fileName      : {
      type     : String,
      default  : undefined,
      required : [true, 'FileName no found'],
    },
    /**
     * Ruta que identifica el objeto dentro del almacenamiento.
     */
    path          : {
      type     : String,
      default  : undefined,
      required : [true, 'Path no found'],
    },
    /**
     * Enlace directo al recurso almacenado.
     */
    rawLink       : {
      type     : String,
      default  : '',
      required : false,
    },
    /**
     * Etiquetas de clasificación asociadas al archivo.
     */
    tags          : {
      type     : [
        {
          type     : String,
          default  : '',
          required : false,
        },
      ],
      default  : [],
      required : false,
    },
    /**
     * Clasificación del recurso utilizada por las operaciones de aplicación.
     */
    type          : {
      type     : String,
      default  : '',
      required : false,
    },
    /**
     * Módulo de aplicación que origina el archivo.
     */
    module        : {
      type     : String,
      default  : undefined,
      required : [true, 'Module no found'],
    },
    /**
     * Visibilidad del archivo y prefijo de almacenamiento: public o private.
     */
    scope         : {
      type     : String,
      default  : undefined,
      required : [true, 'Scope no found'],
    },
    /**
     * Tamaño del archivo expresado en bytes.
     */
    size          : {
      type     : Number,
      default  : 0,
      required : false,
    },
    /**
     * Nombre original del archivo recibido.
     */
    fileNameReal  : {
      type     : String,
      default  : '',
      required : false,
    },
    /**
     * Extensión del formato del archivo.
     */
    extension     : {
      type     : String,
      default  : '',
      required : false,
    },
    /**
     * Cantidad acumulada de descargas del archivo.
     */
    downloads     : {
      type     : Number,
      default  : 0,
      required : false,
    },
    /**
     * Instante del último acceso al archivo, expresado en milisegundos.
     */
    lastAccess    : {
      type     : Number,
      default  : 0,
      required : false,
    },
    /**
     * Cantidad de elementos asociados al recurso.
     */
    itemsCount    : {
      type     : Number,
      default  : 0,
      required : false,
    },
    /**
     * Indica si el archivo está bloqueado.
     */
    block         : {
      type     : Boolean,
      default  : false,
      required : false,
    },
    /**
     * Indica si el archivo requiere acceso privado.
     */
    private       : {
      type     : Boolean,
      default  : false,
      required : false,
    },
    /**
     * Indica si el archivo cuenta con miniaturas.
     */
    thumbnail     : {
      type     : Boolean,
      default  : false,
      required : false,
    },
    /**
     * Instante de creación del registro, expresado en milisegundos.
     */
    creationDate  : {
      type     : Number,
      /**
       * Ejecuta default dentro del flujo de files.model.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      default  : function () {
        return new Date().getTime();
      },
      required : false,
    },
    /**
     * Instante de la última modificación del registro, expresado en milisegundos.
     */
    updateDate    : {
      type     : Number,
      /**
       * Ejecuta default dentro del flujo de files.model.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      default  : function () {
        return new Date().getTime();
      },
      required : false,
    },
    /**
     * Marca de baja lógica; su valor no altera automáticamente los filtros de lectura.
     */
    erased        : {
      type     : Boolean,
      default  : false,
      required : false,
    },
    /**
     * Identificador de correlación de la operación que produjo el registro.
     */
    idTransaction : {
      type     : String,
      default  : '',
      required : false,
    },
  });
  // Metadatos aditivos para Files administrado por el dominio consumidor.
  schema.add({
    cleanupOwner  : {
      type    : String,
      default : '',
      select  : false,
    },
    cleanupUntil  : {
      type    : Number,
      default : 0,
      select  : false,
    },
    storageId     : {
      type    : String,
      default : undefined,
    },
    originService : {
      type    : String,
      default : undefined,
    },
    resourceType  : {
      type    : String,
      default : undefined,
    },
    resourceCode  : {
      type    : String,
      default : undefined,
    },
    storageState  : {
      type    : String,
      default : undefined,
    },
    digest        : {
      type    : String,
      default : undefined,
    },
    mimeType      : {
      type    : String,
      default : undefined,
    },
    totalSize     : {
      type    : Number,
      default : undefined,
    },
    variants      : {
      type    : [
        new Schema(
          {
            label    : String,
            key      : String,
            size     : Number,
            width    : Number,
            height   : Number,
            mimeType : String,
          },
          { _id: false },
        ),
      ],
      default : undefined,
    },
  });
  schema.index(
    { storageId: 1 },
    {
      unique                  : true,
      partialFilterExpression : { storageId: { $type: 'string' } },
    },
  );
  schema.index({
    storageState : 1,
    cleanupUntil : 1,
    _id          : 1,
  });
  schema.pre(
    'validate',

    /**
     * Comprueba las condiciones de validateAccessMetadata antes de continuar.
     * @returns {void} Finaliza después de aplicar los efectos de la operación.
     */
    function validateAccessMetadata() {
      for (const field of ['workspace', 'userCreate', 'userAssigned']) {
        if (typeof this[field] !== 'string') this.invalidate(field, 'ACCESS_METADATA_REQUIRED');
      }
    },
  );
  schema.index({
    workspace  : 1,
    userCreate : 1,
  });
  schema.index({
    workspace    : 1,
    userAssigned : 1,
  });

  schema.set('versionKey', false);
  schema.set('autoIndex', false);
  schema.index({
    type : -1,
  });
  return mongoose.model('DOCUMENTS_FILES', schema, 'DOCUMENTS_FILES');
};
