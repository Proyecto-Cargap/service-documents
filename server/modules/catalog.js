/** @file Composición de capacidades y catálogo público; sólo se construye al iniciar mensajería. */
'use strict';

/**
 * Compone createCatalog con las dependencias recibidas y devuelve su interfaz.
 * @param {Object} options Colaboradores u opciones: messaging, env, logger.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function createCatalog({ messaging, env = process.env, logger = require('../telemetry').logger }) {
  const identity               = require('../../package.json');
  const general                = require('../shared/general');
  const temporaryFiles         = require('../adapters/filesystem/temporary-files').createTemporaryFiles({
    root      : env.TEMP,
    readRoots : require('../adapters/rendering/pdf-registry').approvedRoots(env),
  });
  const aws                    = require('@aws-sdk/client-s3');
  const s3                     = require('../adapters/storage/s3-storage').createS3Storage({
    client   : new aws.S3Client({
      region : env.AWS_REGION,
    }),
    commands : aws,
  });
  const storage                = require('../adapters/storage/object-storage').objectStorage({ storage: s3 });
  /**
   * Compone createRenderer con las dependencias recibidas y devuelve su interfaz.
   * @param {*} errors Valor de errors utilizado por esta operación.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  const createRenderer         = (errors) =>
    require('../adapters/rendering/pdf-renderer').createPdfRenderer({
      ...errors,
      temporaryFiles,
      logger,
      puppeteer : require('puppeteer'),
      PDFMerger : require('pdf-merger-js').default,
    });
  const mongoose               = require('mongoose');
  const documentPersistence    =
    require('../adapters/mongodb/document-persistence').documentPersistence({
      mongoose,
      connection : mongoose.connection,
    });
  const settingsModel          = require('./settings/models/settings.model')({
    mongoose : require('mongoose'),
  });
  const settingsRepository     = require('./settings/repositories/settings.repository')({
    messaging,
    model      : settingsModel,
    getSession : documentPersistence.current,
  });
  const settingsController     = require('./settings/controllers/settings.controller')({
    messaging          : messaging,
    settingsRepository : settingsRepository,
    identity           : identity,
  });
  const filesModel             = require('./files/models/files.model')({
    mongoose : require('mongoose'),
  });
  const filesRepository        = require('./files/repositories/files.repository')({
    messaging,
    model : filesModel,
  });
  const images                 = require('../adapters/media/image-processor').imageProcessor(require('sharp'));
  const filesService           = require('./files/services/files.service')({
    storage            : storage,
    messaging          : messaging,
    settingsRepository : settingsRepository,
    identity           : identity,
    temporaryFiles     : temporaryFiles,
    imageProcessor     : images,
    filesRepository    : filesRepository,

    /**
     * Ejecuta newFileId y devuelve el resultado al flujo que lo invoca.
     * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
     */
    newFileId          : () => new (require('mongoose').Types.ObjectId)().toHexString(),
    env                : env,
    logger             : logger,
  });
  const filesController        = require('./files/controllers/files.controller')({
    messaging    : messaging,
    identity     : identity,
    filesService : filesService,
  });
  const filesStorageRepository = require('./files/repositories/files-storage.repository')({
    model : filesModel,
  });
  const filesStorageService    = require('./files/services/files-storage.service')({
    repository     : filesStorageRepository,
    storage,
    temporaryFiles,
    settingsRepository,
    imageProcessor : images,
    messaging,
    env,
    logger,
  });
  const filesCleanupWorker     = require('../library/work/reactive-worker').createReactiveWorker({
    source    : require('../library/work/mongo-changes').createMongoChanges({
      connection   : filesModel.db,
      collections  : [filesModel.collection.name],
      updateFields : ['storageState', 'cleanupUntil'],
      logger,
      component    : 'files_cleanup',
    }),
    nextAt    : filesStorageRepository.nextDeletionAt,
    /** @param {Object} options Continuidad del trabajador. @returns {Promise<void>} Reintenta sólo borrados acreditados y vencidos. */
    tick      : (options) => filesStorageService.recover(options),
    logger,
    component : 'files_cleanup',
  });
  const filesStorage           = require('./files/controllers/files-storage.controller')({
    messaging,
    service : filesStorageService,
  });
  const qrProcessor            = require('../adapters/media/qr-processor').qrProcessor({
    QRCodeCanvas : require('@loskir/styled-qr-code-node').QRCodeCanvas,
    Jimp         : require('jimp').Jimp,
    QrReader     : require('qrcode-reader'),
  });
  const qrcodeService          = require('./qrcode/services/qrcode.service')({
    messaging          : messaging,
    settingsRepository : settingsRepository,
    identity           : identity,
    qrProcessor,
    temporaryFiles     : temporaryFiles,
    filesService       : filesService,
    env                : env,
    logger             : logger,
  });
  const qrcodeController       = require('./qrcode/controllers/qrcode.controller')({
    messaging     : messaging,
    qrcodeService : qrcodeService,
  });
  const documentRepositories   = {};
  const documentModels         = {};
  const persistenceFactories   = {
    repositories : {
      model      : require('./repositories/models/repositories.model'),
      repository : require('./repositories/repositories/repositories.repository'),
    },
    entries      : {
      model      : require('./entries/models/entries.model'),
      repository : require('./entries/repositories/entries.repository'),
    },
    favorites    : {
      model      : require('./favorites/models/favorites.model'),
      repository : require('./favorites/repositories/favorites.repository'),
    },
    operations   : {
      model      : require('./operations/models/operations.model'),
      repository : require('./operations/repositories/operations.repository'),
    },
  };
  for (const [capability, factories] of Object.entries(persistenceFactories)) {
    documentModels[capability] = factories.model({ mongoose });
    documentRepositories[`${capability}Repository`] = factories.repository({
      model      : documentModels[capability],
      messaging,
      getSession : documentPersistence.current,
    });
  }
  const documentsService    = require('./documents/services/documents.service')({
    ...documentRepositories,
    messaging,
    unitOfWork     : documentPersistence,
    ids            : documentPersistence.ids,
    resourceAccess : require('../adapters/messaging/resource-access').createResourceAccess({
      messaging,
    }),
    settingsRepository,
    storage        : require('../adapters/storage/document-storage').documentStorage({
      storage : s3,
      bucket  : env.BUCKET_DOCUMENTS,
    }),
    temporaryFiles,
    utilities      : general,
    env,
    logger,
  });
  const recoveryRepository  =
    require('./documents/repositories/recovery.repository').documentRecoveryRepository(
      documentModels,
    );
  const recoveryWorker      = require('../library/work/reactive-worker').createReactiveWorker({
    source    : require('../library/work/mongo-changes').createMongoChanges({
      connection   : mongoose.connection,
      collections  : ['operations', 'entries', 'repositories'].map(
        /** @param {string} name Modelo técnico. @returns {string} Colección observada. */
        (name) => documentModels[name].collection.name,
      ),
      updateFields : [
        'state',
        'leaseUntil',
        'erased',
        'purgeAfter',
        'trashRootId',
        'resourceCleanupPending',
      ],
      logger,
      component    : 'documents_recovery',
    }),
    nextAt    : recoveryRepository.nextAt,
    /** @param {Object} options Continuidad y cierre del trabajador. @returns {Promise<void>} Procesa sólo journal y vencimientos acreditados. */
    tick      : (options) => documentsService.recoverOnce(options),
    logger,
    component : 'documents_recovery',
  });
  const delegateDocuments   =
    require('./delegation/services/document-delegation.service').documentDelegation({
      messaging,
      unitOfWork : documentPersistence,
      manifest   : require('../contracts/service.json'),
      /** @param {string} name Acción. @param {Object} value Sobre. @returns {Object} DTO canónico validado antes de confirmar el recibo. */
      present    : (name, value) => require('../contracts/index').actionDtos[name].output(value),
      documents  : documentsService,
    });
  const documentsController = require('./documents/controllers/documents.controller')({
    messaging,
    documentsService,
  });
  const countersModel       = require('./counters/models/counters.model')({
    mongoose : require('mongoose'),
  });
  const countersRepository  = require('./counters/repositories/counters.repository')({
    messaging,
    model : countersModel,
  });
  const richHtml            = require('./pdf/contracts/rich-html')({
    sanitizeHtml : require('sanitize-html'),
    env          : env,
  });
  const pdfService          = require('./pdf/services/pdf.service')({
    qrProcessor,
    messaging      : messaging,
    utilities      : {
      ...general,
      getObjectCode : countersRepository.getObjectCode,
    },
    identity       : identity,
    temporaryFiles : temporaryFiles,
    createRenderer : createRenderer,
    pdfRegistry    : {
      /**
       * Ejecuta load y devuelve el resultado al flujo que lo invoca.
       * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
       */
      load  : () => require('../adapters/rendering/pdf-registry').loadRegistry(env),
      asset : require('../adapters/rendering/pdf-registry').approvedAsset,
    },
    handlebars     : require('handlebars'),
    richHtml       : richHtml,
    env            : env,
    logger         : logger,
  });
  const pdfController       = require('./pdf/controllers/pdf.controller')({
    messaging  : messaging,
    pdfService : pdfService,
  });
  const attachments         = require('./attachment/controllers/attachment.controller')({
    messaging,
    service : require('./attachment/services/attachment.service')({
      attachmentAudio : require('../adapters/media/attachment-audio').attachmentAudio,
      attachmentImage : require('../adapters/media/attachment-image').attachmentImage,
      storage,
      temporaryFiles,
      settingsRepository,
      env,
      repository      : require('./attachment/repositories/attachment.repository')({
        model      : require('./attachment/models/attachment.model')({
          mongoose : require('mongoose'),
        }),
        connection : require('mongoose').connection,
      }),
    }),
  });
  const catalog             = delegateDocuments([
    {
      name    : 'documents-repository-resolve',
      kind    : 'action',
      /** @param {Object} message Referencia validada. @returns {Promise<Object>} Repositorio acreditado. */
      handler : async (message) =>
        messaging.successResponse(200, await documentsService.resolveRepository(message.data)),
    },
    {
      name    : 'documents-view-get',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} message Mensaje recibido con datos y contexto del transporte.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (message) => documentsController.getView(message),
    },
    ...[
      ['upload', 'upload'],
      ['read', 'read'],
      ['delete', 'remove'],
      ['public-read', 'readPublic'],
    ].map(
      /**
       * Proyecta cada elemento en la estructura requerida por la operación.
       * @param {Array<*>} argument1 Valor de argument1 utilizado por esta operación.
       * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      ([operation, handler]) => ({
        name    : `files-storage-${operation}`,
        kind    : 'action',
        /**
         * Atiende el mensaje con el contrato y las reglas de la operación.
         * @param {Object} message Mensaje recibido con datos y contexto del transporte.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        handler : (message) => filesStorage[handler](message),
      }),
    ),
    ...['upload', 'download', 'preview', 'delete', 'discard', 'status'].map(
      /**
       * Proyecta cada elemento en la estructura requerida por la operación.
       * @param {*} operation Valor de operation utilizado por esta operación.
       * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (operation) => ({
        name    : `attachment-${operation}`,
        kind    : 'action',
        /**
         * Delega el almacenamiento privado del recurso propietario acreditado.
         * @param {Object} message Sobre y origen acreditados por la mensajería.
         * @returns {Promise<Object>} Respuesta uniforme de la capacidad.
         */
        handler : (message) => attachments[operation](message),
      }),
    ),
    ...[
      ['documents-repository-manifest-get', 'getManifest'],
      ['documents-entry-references', 'getReferences'],
      ['documents-settings-get', 'getSettings'],
      ['documents-settings-update', 'updateSettings'],
      ['documents-file-upload-prepare', 'prepareUpload'],
      ['documents-entry-download-prepare', 'prepareDownload'],
      ['documents-upload-status', 'uploadStatus'],
    ].map(
      /** @param {Array<string>} definition Acción y caso de uso. @returns {Object} Entrada canónica. */ ([
        name,
        method,
      ]) => ({
        name,
        kind : 'action',
        /** @param {Object} message Entrada validada. @returns {Promise<Object>} Sobre de la capacidad documental. */
        async handler(message) {
          return messaging.successResponse(200, await documentsService[method](message.data));
        },
      }),
    ),
    {
      name    : 'documents-repositories-get-list',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} mqMessage Mensaje recibido por el controlador RPC.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (mqMessage) => documentsController.getRepositories(mqMessage),
    },
    {
      name    : 'documents-entries-get-list',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} mqMessage Mensaje recibido por el controlador RPC.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (mqMessage) => documentsController.getList(mqMessage),
    },
    {
      name    : 'documents-folder-create',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} mqMessage Mensaje recibido por el controlador RPC.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (mqMessage) => documentsController.createFolder(mqMessage),
    },
    {
      name    : 'documents-file-upload',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} mqMessage Mensaje recibido por el controlador RPC.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (mqMessage) => documentsController.upload(mqMessage),
    },
    {
      name    : 'documents-entry-get-one',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} mqMessage Mensaje recibido por el controlador RPC.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (mqMessage) => documentsController.getOne(mqMessage),
    },
    {
      name    : 'documents-entry-rename',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} mqMessage Mensaje recibido por el controlador RPC.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (mqMessage) => documentsController.rename(mqMessage),
    },
    {
      name    : 'documents-entry-move',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} mqMessage Mensaje recibido por el controlador RPC.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (mqMessage) => documentsController.move(mqMessage),
    },
    {
      name    : 'documents-trash-get-list',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} message Mensaje recibido con datos y contexto del transporte.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (message) => documentsController.getTrash(message),
    },
    {
      name    : 'documents-entry-restore',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} message Mensaje recibido con datos y contexto del transporte.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (message) => documentsController.restore(message),
    },
    {
      name    : 'documents-entry-delete',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} mqMessage Mensaje recibido por el controlador RPC.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (mqMessage) => documentsController.delete(mqMessage),
    },
    {
      name    : 'documents-entry-download',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} mqMessage Mensaje recibido por el controlador RPC.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (mqMessage) => documentsController.download(mqMessage),
    },
    {
      name    : 'documents-favorites-get-list',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} mqMessage Mensaje recibido por el controlador RPC.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (mqMessage) => documentsController.getFavorites(mqMessage),
    },
    {
      name    : 'documents-favorite-create',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} mqMessage Mensaje recibido por el controlador RPC.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (mqMessage) => documentsController.addFavorite(mqMessage),
    },
    {
      name    : 'documents-favorite-delete',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} mqMessage Mensaje recibido por el controlador RPC.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (mqMessage) => documentsController.removeFavorite(mqMessage),
    },

    {
      name    : 'files-create',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} mqMessage Mensaje recibido por el controlador RPC.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (mqMessage) => filesController.create(mqMessage),
    },
    {
      name    : 'files-update',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} mqMessage Mensaje recibido por el controlador RPC.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (mqMessage) => filesController.update(mqMessage),
    },
    {
      name    : 'files-get-one',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} mqMessage Mensaje recibido por el controlador RPC.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (mqMessage) => filesController.getOne(mqMessage),
    },
    {
      name    : 'files-clone',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} mqMessage Mensaje recibido por el controlador RPC.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (mqMessage) => filesController.clone(mqMessage),
    },
    {
      name    : 'files-delete',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} mqMessage Mensaje recibido por el controlador RPC.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (mqMessage) => filesController.delete(mqMessage),
    },
    {
      name    : 'qrcode-create',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} mqMessage Mensaje recibido por el controlador RPC.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (mqMessage) => qrcodeController.create(mqMessage),
    },
    {
      name    : 'qrcode-decode',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} mqMessage Mensaje recibido por el controlador RPC.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (mqMessage) => qrcodeController.decode(mqMessage),
    },
    {
      name    : 'pdf-rich-description-create',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} mqMessage Mensaje recibido por el controlador RPC.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (mqMessage) => pdfController.richDescriptionCreate(mqMessage),
    },
    {
      name    : 'pdf-quote-create',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} mqMessage Mensaje recibido por el controlador RPC.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (mqMessage) => pdfController.quoteCreate(mqMessage),
    },
    {
      name    : 'pdf-cnr-create',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} mqMessage Mensaje recibido por el controlador RPC.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (mqMessage) => pdfController.cnrCreate(mqMessage),
    },
    {
      name    : 'pdf-purchase-order-create',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} mqMessage Mensaje recibido por el controlador RPC.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (mqMessage) => pdfController.purchaseOrderCreate(mqMessage),
    },
    {
      name    : 'pdf-billing-commercial-create',
      kind    : 'action',
      /** @param {Object} message Vista comercial interna. @returns {Promise<Object>} PDF privado. */
      handler : (message) => pdfController.commercialCreate(message),
    },
    {
      name    : 'pdf-billing-create',
      kind    : 'action',
      /** @param {Object} message Mensaje interno de Billing. @returns {Promise<Object>} PDF desde la proyección del XML confirmado. */
      handler : (message) => pdfController.billingCreate(message),
    },
    {
      name    : 'pdf-invoice-create',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} mqMessage Mensaje recibido por el controlador RPC.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (mqMessage) => pdfController.invoiceCreate(mqMessage),
    },
    {
      name    : 'pdf-invoice-cancel-create',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} mqMessage Mensaje recibido por el controlador RPC.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (mqMessage) => pdfController.invoiceCancelCreate(mqMessage),
    },
    {
      name    : 'pdf-complement-create',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} mqMessage Mensaje recibido por el controlador RPC.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (mqMessage) => pdfController.complementCreate(mqMessage),
    },
    {
      name    : 'settings-get-one',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} mqMessage Mensaje recibido por el controlador RPC.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (mqMessage) => settingsController.getOne(mqMessage),
    },
    {
      name    : 'settings-get-list',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} mqMessage Mensaje recibido por el controlador RPC.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (mqMessage) => settingsController.getList(mqMessage),
    },
    {
      name    : 'settings-update',
      kind    : 'action',
      /**
       * Atiende el mensaje con el contrato y las reglas de la operación.
       * @param {Object} mqMessage Mensaje recibido por el controlador RPC.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      handler : (mqMessage) => settingsController.update(mqMessage),
    },
  ]);
  catalog.documentsLifecycle = {
    /**
     * Inicia el componente y sus colaboradores.
     * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
     */
    async start() {
      await filesStorageService.start();
      filesCleanupWorker.start();
      await documentsService.start();
      recoveryWorker.start();
    },
    /**
     * Cierra el componente y libera sus recursos.
     * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
     */
    async close() {
      await documentsService.close();
      await recoveryWorker.close();
      await filesCleanupWorker.close();
      await filesStorageService.close();
    },
  };
  return catalog;
}
module.exports = {
  createCatalog : require('../contracts/index').catalogFactory(createCatalog),
};
