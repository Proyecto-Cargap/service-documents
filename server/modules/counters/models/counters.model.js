/**
 * Compone createCountersModel con las dependencias recibidas y devuelve su interfaz.
 * @param {Object} dependencies Colaboradores explícitos de la composición.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
module.exports = function createCountersModel(dependencies) {
  /**
   * @file Esquema Mongoose de contadores de identificadores: campos, valores predeterminados y reglas de
   * persistencia.
   * Define la estructura utilizada al crear y consultar documentos de este recurso.
   */
  const mongoose      = dependencies.mongoose;
  const Schema        = mongoose.Schema;
  const counterSchema = new Schema(
    {
      /**
       * Espacio de trabajo del registro; allWorkspaces identifica recursos compartidos.
       */
      workspace    : {
        type     : String,
        default  : undefined,
        required : true,
      },
      /**
       * Código del usuario autor; permanece inmutable después de crear el registro.
       */
      userCreate   : {
        type      : String,
        default   : undefined,
        required  : false,
        immutable : true,
      },
      /**
       * Código del usuario responsable; vacío cuando no existe una asignación.
       */
      userAssigned : {
        type     : String,
        default  : undefined,
        required : false,
      },
      /**
       * Identificador único del documento dentro de la colección.
       */
      _id          : {
        type     : String,
        default  : undefined,
        required : [true, 'Sec not found'],
      },
      /**
       * Último valor de la secuencia persistente del contador.
       */
      seq          : {
        type     : Number,
        default  : undefined,
        required : [true, 'Sec not found'],
      },
    },
    {
      versionKey : false,
    },
  );
  counterSchema.pre(
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
  counterSchema.index({
    workspace  : 1,
    userCreate : 1,
  });
  counterSchema.index({
    workspace    : 1,
    userAssigned : 1,
  });

  return mongoose.model('FILES_COUNTER', counterSchema, 'FILES_COUNTER');
};
