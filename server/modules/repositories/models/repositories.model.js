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
      subject                : {
        type      : new Schema(
          {
            service : {
              type     : String,
              required : true,
            },
            domain  : {
              type     : String,
              required : true,
            },
            code    : {
              type     : String,
              required : true,
            },
          },
          {
            _id    : false,
            strict : true,
          },
        ),
        default   : undefined,
        immutable : true,
      },
      resourcePurgeAfter     : {
        type    : Number,
        default : 0,
        min     : 0,
      },
      resourceDeletedAt      : {
        type    : Number,
        default : 0,
        min     : 0,
      },
      resourceCleanupPending : {
        type    : Boolean,
        default : false,
      },
      workspace              : {
        type     : String,
        default  : 'allWorkspaces',
        required : true,
      },
      /**
       * Autor del registro; permanece inmutable.
       */
      userCreate             : {
        type      : String,
        default   : undefined,
        required  : true,
        immutable : true,
      },
      /**
       * Responsable asignado; vacío cuando no corresponde.
       */
      userAssigned           : {
        type     : String,
        default  : '',
        required : false,
      },
      /**
       * Fecha de creación en milisegundos.
       */
      creationDate           : {
        type     : Number,
        default  : Date.now,
        required : false,
      },
      /**
       * Fecha de última modificación en milisegundos.
       */
      updateDate             : {
        type     : Number,
        default  : Date.now,
        required : false,
      },
      /**
       * Marca explícita de baja lógica.
       */
      erased                 : {
        type     : Boolean,
        default  : false,
        required : false,
      },
      /**
       * Identidad de la transacción que originó el registro.
       */
      idTransaction          : {
        type     : String,
        default  : '',
        required : false,
      },
      /**
       * Namespace físico personal, workspace o global.
       */
      kind                   : {
        type     : String,
        default  : undefined,
        required : true,
      },
      /**
       * Propietario, código de workspace o clave global, fijado por servidor.
       */
      namespaceKey           : {
        type     : String,
        default  : undefined,
        required : true,
      },
      /**
       * Propietario de la raíz personal; no representa el creador de cada archivo.
       */
      ownerCode              : {
        type     : String,
        default  : '',
        required : false,
      },
      /**
       * Nombre público del repositorio.
       */
      name                   : {
        type     : String,
        default  : undefined,
        required : true,
      },
      /**
       * Actor que materializó técnicamente la raíz.
       */
      provisioningBy         : {
        type     : String,
        default  : '',
        required : false,
      },
      /**
       * Bytes de versiones activas del repositorio.
       */
      usedSpace              : {
        type     : Number,
        default  : 0,
        required : false,
        min      : 0,
      },
      /**
       * Bytes reservados por cargas pendientes durables.
       */
      reservedSpace          : {
        type     : Number,
        default  : 0,
        required : false,
        min      : 0,
      },
      /**
       * Límite de capacidad propia en bytes.
       */
      availableSpace         : {
        type     : Number,
        default  : undefined,
        required : true,
        min      : 0,
      },
      /**
       * Límite por archivo en bytes.
       */
      sizeFileMax            : {
        type     : Number,
        default  : undefined,
        required : true,
        min      : 0,
      },
      /**
       * Coordinador de mutaciones del árbol y cuota.
       */
      revision               : {
        type     : Number,
        default  : 0,
        required : false,
        min      : 0,
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
      kind         : 1,
      namespaceKey : 1,
    },
    {
      unique : true,
      name   : 'documents_repository_namespace',
    },
  );
  schema.path('kind').enum(...['personal', 'workspace', 'global', 'resource']);
  for (const field of ['kind', 'namespaceKey', 'ownerCode']) schema.path(field).immutable(true);
  schema.pre(
    'validate',

    /**
     * Comprueba las condiciones de validateNamespace antes de continuar.
     * @returns {void} Finaliza después de aplicar los efectos de la operación.
     */
    function validateNamespace() {
      if (this.kind === 'resource') {
        try {
          const { resourceNamespace } = require('../contracts/resource-subject');
          if (
            this.namespaceKey !== resourceNamespace(this.subject?.toObject?.() || this.subject) ||
            (this.subject?.service === 'service-support'
              ? !this.workspace || this.workspace === 'allWorkspaces'
              : this.workspace !== 'allWorkspaces')
          )
            this.invalidate('namespaceKey', 'DOCUMENT_NAMESPACE_INVALID');
        } catch {
          this.invalidate('subject', 'INVALID_DOCUMENT_SUBJECT');
        }
      }
      if (
        this.kind === 'personal' &&
        (this.ownerCode !== this.namespaceKey ||
          this.userCreate !== this.ownerCode ||
          this.workspace !== 'allWorkspaces')
      )
        this.invalidate('namespaceKey', 'DOCUMENT_NAMESPACE_INVALID');
      if (
        this.kind === 'workspace' &&
        (this.workspace !== this.namespaceKey || this.workspace === 'allWorkspaces')
      )
        this.invalidate('namespaceKey', 'DOCUMENT_NAMESPACE_INVALID');
      if (
        this.kind === 'global' &&
        (this.namespaceKey !== 'global' || this.workspace !== 'allWorkspaces')
      )
        this.invalidate('namespaceKey', 'DOCUMENT_NAMESPACE_INVALID');
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
    mongoose.models?.DOCUMENTS_REPOSITORIES ||
    mongoose.model('DOCUMENTS_REPOSITORIES', schema, 'DOCUMENTS_REPOSITORIES')
  );
};
