/** @file Aceptación de Documents delegado con MongoDB aislado, contratos reales y almacenamiento sintético. */
'use strict';
const test                       = require('node:test');
const assert                     = require('node:assert/strict');
const fs                         = require('node:fs/promises');
const os                         = require('node:os');
const path                       = require('node:path');
const { AsyncLocalStorage }      = require('node:async_hooks');
const { createHash, randomUUID } = require('node:crypto');
const mongoose                   = require('mongoose');
const { startIsolatedMongo }     = require('./isolated-mongo.cjs');
const contracts                  = require('../../server/contracts');
/** @param {Object} t Prueba propietaria de los recursos. @param {Object} options Acceso por recurso y modalidad delegada. @returns {Promise<Object>} Servicio, repositorios y recibos reales con productores externos sintéticos. */
async function fixture(t, { resourceAccess, delegated = true } = {}) {
  const database = await startIsolatedMongo({
    binary : process.env.TEST_MONGOD_BINARY,
    mongoose,
  });
  let activeService;
  t.after(
    /** @returns {Promise<void>} Cierra el dominio antes de su base aislada. */ async () => {
      await activeService?.close();
      await database.stop();
    },
  );
  const connection = database.connection,
    db             = connection.db,
    local          = new AsyncLocalStorage();
  const unitOfWork =
    require('../../server/adapters/mongodb/document-persistence').documentPersistence({
      mongoose,
      connection,
    });
  const root       = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-documents-'));
  const state      = {
    revoked     : false,
    failEvent   : false,
    revokeOnPut : false,
    puts        : 0,
  };
  const policies   = [];
  for (const [resource, scopes] of Object.entries({
    personal  : ['owner', 'global'],
    workspace : ['workspace', 'global'],
    global    : ['global'],
    settings  : ['global'],
  }))
    for (const action of ['view', 'create', 'update', 'delete'])
      for (const scope of scopes) policies.push(`documents.${resource}.${action}.${scope}`);
  const actor     = {
    user       : { userCode: 'U1' },
    workspace  : 'W1',
    workspaces : ['W1'],
    policies,
    ...(delegated
      ? {
          delegation : {
            grantCode : 'G1',
            clientId  : 'C1',
          },
        }
      : {}),
  };
  const messaging = {
    /** @returns {Object} Identidad aislada. */ getContext                                                                 : () => local.getStore() || actor,
    /** @param {Object} value Identidad. @param {Function} work Trabajo. @returns {*} Resultado aislado. */ runWithContext :
      (value, work) => local.run(value, work),
    /** @param {string} service Destino. @param {string} action Acción. @param {Object} data Usuarios. @returns {Promise<Object>} Security sintético con revocación inmediata. */ async request(
      service,
      action,
      data,
    ) {
      if (action === 'workspace-principals-get-list' && !state.revoked)
        return {
          statusCode : 200,
          data       : {
            items : data.userCodes.map(
              /** @param {string} userCode Cuenta. @returns {Object} Políticas vigentes de la prueba. */
              (userCode) => ({
                userCode,
                workspace : data.workspace,
                policies  : actor.policies,
              }),
            ),
          },
        };
      return state.revoked
        ? { statusCode: 401 }
        : {
            statusCode : 200,
            data       : {
              userCode   : 'U1',
              workspace  : 'W1',
              workspaces : ['W1'],
              policies   : actor.policies,
              scopes     : [
                'documents:read',
                'documents:write',
                'documents:delete',
                'documents:upload',
                'documents:download',
                'documents:settings',
              ],
            },
          };
    },
    /** @param {string} name Evento. @param {Object} data Proyección. @param {Object} options Transacción. @returns {Promise<void>} Outbox atómico real. */ async publishEvent(
      name,
      data,
      options = {},
    ) {
      await db.collection('TEST_OUTBOX').insertOne(
        {
          name,
          data,
        },
        { session: options.session || unitOfWork.current() },
      );
      if (state.failEvent) throw new Error('OUTBOX_FAILED');
    },
  };
  const factory  = {
      Schema : mongoose.Schema,
      Types  : mongoose.Types,
      model  : connection.model.bind(connection),
    },
    repositories = {};
  for (const name of ['repositories', 'entries', 'favorites', 'operations']) {
    const model = require('../../server/modules/' + name + '/models/' + name + '.model')({
      mongoose : factory,
    });
    repositories[name + 'Repository'] = require(
      '../../server/modules/' + name + '/repositories/' + name + '.repository',
    )({
      model,
      messaging,
      getSession : unitOfWork.current,
    });
  }
  const settingsModel = require('../../server/modules/settings/models/settings.model')({
    mongoose : factory,
  });
  for (const [name, indexes] of Object.entries(
    require('../../server/mongodb-indexes.json').collections,
  )) {
    await db.createCollection(name);
    for (const { key, ...options } of indexes) await db.collection(name).createIndex(key, options);
  }
  await settingsModel.create({
    parameter    : 'documents-settings',
    workspace    : 'allWorkspaces',
    userCreate   : 'U1',
    userAssigned : '',
    data         : {
      availableSpace     : 1000000,
      sizeFileMax        : 500000,
      usedSpace          : 0,
      trashRetentionDays : 30,
    },
  });
  const objects = new Map();
  const service = require('../../server/modules/documents/services/documents.service')({
    ...repositories,
    messaging,
    resourceAccess     : resourceAccess
      ? /** @param {Object} subject Referencia. @param {Object} principal Identidad. @returns {Promise<Object>} Facultades actuales. */
        async (subject, principal) => {
          if (state.revoked) throw Object.assign(new Error('revoked'), { statusCode: 403 });
          return resourceAccess(subject, principal);
        }
      : undefined,
    unitOfWork,
    ids                : unitOfWork.ids,
    settingsRepository : require('../../server/modules/settings/repositories/settings.repository')({
      model      : settingsModel,
      messaging,
      getSession : unitOfWork.current,
    }),
    storage            : {
      /** @param {Object} data Bytes y destino. @returns {Promise<void>} Almacenamiento externo sintético. */ async put(
        data,
      ) {
        state.puts++;
        objects.set(data.key, {
          ...data,
          content : Buffer.from(data.content),
        });
        if (state.revokeOnPut) state.revoked = true;
      },
      /** @param {string} key Objeto. @returns {Promise<Buffer>} Contenido. */ async read(key) {
        return objects.get(key).content;
      },
      /** @param {string} key Objeto. @returns {Promise<Object|null>} Comprobación de recuperación. */ async head(
        key,
      ) {
        const item = objects.get(key);
        return item
          ? {
              size      : item.content.length,
              checksum  : item.checksum,
              operation : item.operation,
            }
          : null;
      },
      /** @param {string} key Objeto. @returns {Promise<void>} Limpieza confirmada. */ async delete(
        key,
      ) {
        objects.delete(key);
      },
    },
    temporaryFiles     : {
      promises                                                          : fs,
      /** @param {string} file Archivo. @returns {Promise<string>} Ruta del entorno aislado. */ async validate(
        file,
      ) {
        assert.equal(path.dirname(file), root);
        return file;
      },
      /** @returns {string} Temporal propio de la prueba. */ uniquePath : () =>
        path.join(root, randomUUID()),
      /** @param {string} file Archivo. @returns {Promise<void>} Limpieza. */ async remove(file) {
        await fs.rm(file, { force: true });
      },
    },
    utilities          : require('../../server/shared/general'),
    env                : {
      ENV_NAME         : 'test',
      BUCKET_DOCUMENTS : 'test',
    },
    logger             : { /** @returns {void} Registro sintético. */ error() {} },
  });
  activeService = service;
  const methods = {
    'documents-view-get'                : 'getView',
    'documents-repository-manifest-get' : 'getManifest',
    'documents-repository-resolve'      : 'resolveRepository',
    'documents-repositories-get-list'   : 'getRepositories',
    'documents-folder-create'           : 'createFolder',
    'documents-entry-get-one'           : 'getOne',
    'documents-entry-references'        : 'getReferences',
    'documents-entries-get-list'        : 'getList',
    'documents-file-upload-prepare'     : 'prepareUpload',
    'documents-file-upload'             : 'upload',
    'documents-upload-status'           : 'uploadStatus',
    'documents-entry-rename'            : 'rename',
    'documents-entry-move'              : 'move',
    'documents-entry-delete'            : 'delete',
    'documents-entry-restore'           : 'restore',
    'documents-trash-get-list'          : 'getTrash',
    'documents-favorite-create'         : 'addFavorite',
    'documents-favorite-delete'         : 'removeFavorite',
    'documents-favorites-get-list'      : 'getFavorites',
    'documents-entry-download-prepare'  : 'prepareDownload',
    'documents-settings-get'            : 'getSettings',
    'documents-settings-update'         : 'updateSettings',
  };
  const entries = Object.entries(methods).map(
    /** @param {Array} pair Acción y método. @returns {Object} Handler canónico. */ ([
      name,
      method,
    ]) => ({
      name,
      kind : 'action',
      /** @param {Object} message Entrada. @returns {Promise<Object>} Sobre canónico. */ async handler(
        message,
      ) {
        return {
          statusCode      : 200,
          descriptionCode : 'OK',
          data            : await service[method](message.data),
        };
      },
    }),
  );
  const wrap    =
    require('../../server/modules/delegation/services/document-delegation.service').documentDelegation(
      {
        messaging,
        unitOfWork,
        documents : service,
        manifest  : contracts.manifest,
      },
    );
  const catalog = contracts.catalog(wrap(entries));
  /** @param {string} name Acción. @param {Object} data Entrada. @param {string} key Clave estable. @returns {Promise<Object>} Datos validados. */
  async function call(name, data = {}, key = randomUUID()) {
    const current = {
      ...actor,
      operation : { idempotencyKey: key },
    };
    return local.run(
      current,
      /** @returns {Promise<Object>} Ejecución aislada. */ async () =>
        (
          await catalog
            .find(
              /** @param {Object} entry Acción. @returns {boolean} Coincidencia. */ (entry) =>
                entry.name === name,
            )
            .handler({ data })
        ).data,
    );
  }
  return {
    call,
    state,
    actor,
    service,
    db,
    root,
    objects,
    connection,
    local,
    unitOfWork,
    messaging,
    /** @returns {Promise<void>} Retira todos los recursos efímeros. */ async close() {
      await service.close();
      await database.stop();
      await fs.rm(root, {
        recursive : true,
        force     : true,
      });
    },
  };
}
module.exports = { fixture };
