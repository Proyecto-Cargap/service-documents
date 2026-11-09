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
      workspace     : {
        type     : String,
        default  : 'allWorkspaces',
        required : true,
      },
      /**
       * Autor del registro; permanece inmutable.
       */
      userCreate    : {
        type      : String,
        default   : undefined,
        required  : true,
        immutable : true,
      },
      /**
       * Responsable asignado; vacío cuando no corresponde.
       */
      userAssigned  : {
        type     : String,
        default  : '',
        required : false,
      },
      /**
       * Fecha de creación en milisegundos.
       */
      creationDate  : {
        type     : Number,
        default  : Date.now,
        required : false,
      },
      /**
       * Fecha de última modificación en milisegundos.
       */
      updateDate    : {
        type     : Number,
        default  : Date.now,
        required : false,
      },
      /**
       * Marca explícita de baja lógica.
       */
      erased        : {
        type     : Boolean,
        default  : false,
        required : false,
      },
      /**
       * Identidad de la transacción que originó el registro.
       */
      idTransaction : {
        type     : String,
        default  : '',
        required : false,
      },
      /**
       * ID estable del archivo o carpeta favorito.
       */
      entryId       : {
        type     : Schema.Types.ObjectId,
        default  : undefined,
        required : true,
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
      userCreate : 1,
      entryId    : 1,
    },
    {
      unique : true,
      name   : 'documents_favorite_actor_entry',
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
    mongoose.models?.DOCUMENTS_FAVORITES ||
    mongoose.model('DOCUMENTS_FAVORITES', schema, 'DOCUMENTS_FAVORITES')
  );
};
