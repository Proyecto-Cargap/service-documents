/** @file Pruebas del almacén de adjuntos genérico, su propiedad y su contrato canónico de persistencia. */
'use strict';
const test              = require('node:test');
const assert            = require('node:assert/strict');
const fs                = require('node:fs/promises');
const os                = require('node:os');
const path              = require('node:path');
const { randomUUID }    = require('node:crypto');
const { Readable }      = require('node:stream');
const createAttachments = require('../server/modules/attachment/services/attachment.service');
const createRepository  = require('../server/modules/attachment/repositories/attachment.repository');

/**
 * Ejecuta fixture dentro del flujo de attachments.test.
 * @param {*} originService Valor de originService utilizado por esta operación.
 * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
async function fixture(originService) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'solid-attachments-'));
  const rows = new Map(),
    objects  = new Map(),
    queries  = [],
    quota    = [];
  const repository = {
    /**
     * Resuelve findOne aplicando los filtros y colaboradores del módulo.
     * @param {Object} filter Filtros de selección que se autorizan antes de consultar.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    findOne          : async (filter) => {
      queries.push(filter);
      const row = rows.get(filter._id);
      return row && (!filter.state || row.state === filter.state) ? { ...row } : null;
    },

    /**
     * Ejecuta insertOne dentro del flujo de attachments.test.
     * @param {*} row Valor de row utilizado por esta operación.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    insertOne        : async (row) => {
      rows.set(row._id, { ...row });
      return row;
    },

    /**
     * Ejecuta updateOne dentro del flujo de attachments.test.
     * @param {Object} filter Filtros de selección que se autorizan antes de consultar.
     * @param {Object} changes Valor de changes utilizado por esta operación.
     * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    updateOne        : async (filter, changes) => {
      const row = rows.get(filter._id);
      if (!row || (filter.state && row.state !== filter.state))
        return {
          matchedCount  : 0,
          modifiedCount : 0,
        };
      Object.assign(row, changes.$set);
      return {
        matchedCount  : 1,
        modifiedCount : 1,
      };
    },

    /**
     * Resuelve findOneAndUpdate aplicando los filtros y colaboradores del módulo.
     * @param {Object} filter Filtros de selección que se autorizan antes de consultar.
     * @param {Object} changes Valor de changes utilizado por esta operación.
     * @returns {Promise<null|Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    findOneAndUpdate : async (filter, changes) => {
      const row = rows.get(filter._id);
      if (!row || !filter.state.$in.includes(row.state)) return null;
      Object.assign(row, changes.$set);
      return { ...row };
    },

    /**
     * Ejecuta transaction dentro del flujo de attachments.test.
     * @param {Function} work Valor de work utilizado por esta operación.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    transaction      : async (work) => work({}),
  };
  const storage    = {
    /**
     * Ejecuta put dentro del flujo de attachments.test.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
     */
    put    : async (input) => {
      if (objects.has(input.key)) throw new Error('exists');
      const parts = [];
      for await (const part of input.content) parts.push(part);
      objects.set(input.key, {
        content  : Buffer.concat(parts),
        metadata : input.metadata,
        mimeType : input.mimeType,
      });
    },

    /**
     * Lee el contenido o registro solicitado.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    read   : async (input) => ({
      content : Readable.from([objects.get(input.key).content]),
    }),

    /**
     * Ejecuta head dentro del flujo de attachments.test.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    head   : async (input) => {
      const item = objects.get(input.key);
      return item
        ? {
            size     : item.content.length,
            metadata : item.metadata,
            mimeType : item.mimeType,
          }
        : null;
    },

    /**
     * Elimina el recurso indicado según las reglas del módulo.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
     */
    delete : async (input) => {
      objects.delete(input.key);
    },
  };
  const service    = createAttachments({
    attachmentAudio    : require('../server/adapters/media/attachment-audio').attachmentAudio,
    attachmentImage    : require('../server/adapters/media/attachment-image').attachmentImage,
    storage,
    repository,
    settingsRepository : {
      /**
       * Ejecuta adjustUsedSpace dentro del flujo de attachments.test.
       * @param {number|string} size Valor de size utilizado por esta operación.
       * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      adjustUsedSpace : async (size) => quota.push(size),
    },
    env                : { BUCKET_DOCUMENTS: 'private' },
    temporaryFiles     : {
      /**
       * Ejecuta readStream y devuelve el resultado al flujo que lo invoca.
       * @param {*} filename Valor utilizado por la operación.
       * @returns {Promise<*>} Resultado de la operación; los fallos se propagan al flujo invocador.
       */
      readStream  : async (filename) => require('node:fs').createReadStream(filename),

      /**
       * Ejecuta writeStream y devuelve el resultado al flujo que lo invoca.
       * @param {*} filename Valor utilizado por la operación.
       * @param {*} options Valor utilizado por la operación.
       * @returns {Promise<*>} Resultado de la operación; los fallos se propagan al flujo invocador.
       */
      writeStream : async (filename, options) =>
        require('node:fs').createWriteStream(filename, options),
      promises    : fs,
      /**
       * Valida la entrada antes de continuar con la operación.
       * @param {string} filename Ruta del archivo que se procesa.
       * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      validate    : async (filename) => {
        assert(filename.startsWith(directory + path.sep));
        return filename;
      },
      /**
       * Retira el recurso indicado.
       * @param {string} filename Ruta del archivo que se procesa.
       * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      remove      : async (filename) => fs.rm(filename, { force: true }),
      /**
       * Ejecuta uniquePath dentro del flujo de attachments.test.
       * @param {*} label Valor de label utilizado por esta operación.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      uniquePath  : (label) => path.join(directory, randomUUID() + '-' + label),
    },
  });
  const data       = {
    attachmentCode : randomUUID(),
    resourceType   : 'business-message',
    resourceCode   : 'message-1',
    size           : 3,
  };

  /**
   * Ejecuta upload dentro del flujo de attachments.test.
   * @param {string} content Bytes de la evidencia sintética.
   * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  async function upload(content = 'abc') {
    const filename = path.join(directory, randomUUID());
    await fs.writeFile(filename, content);
    return service.upload(
      {
        ...data,
        size         : Buffer.byteLength(content),
        tempFilePath : filename,
      },
      originService,
    );
  }
  return {
    service,
    data,
    upload,
    quota,
    queries,
    rows,
    objects,
    /**
     * Cierra el componente y libera sus recursos.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    close : () =>
      fs.rm(directory, {
        recursive : true,
        force     : true,
      }),
  };
}

test('dos dominios reutilizan el mismo flujo y las mismas consultas sin duplicar cuota' /**
 * Verifica el comportamiento esperado del caso de prueba.
 * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
 */, async () => {
  const signatures = [];
  for (const origin of ['service-connect', 'service-platform']) {
    const f = await fixture(origin);
    try {
      assert.deepEqual(await f.upload(), { mime: 'application/octet-stream' });
      assert.deepEqual(await f.upload(), { mime: 'application/octet-stream' });
      assert.deepEqual(f.quota, [3]);
      const status = await f.service.status(f.data, origin);
      assert.equal(status.state, 'ready');
      assert.equal(status.size, 3);
      const download = await f.service.download(f.data, origin);
      assert.equal(await fs.readFile(download.tempFilePath, 'utf8'), 'abc');
      await f.service.discard(
        {
          ...f.data,
          tempFilePath : download.tempFilePath,
        },
        origin,
      );
      await assert.rejects(fs.stat(download.tempFilePath));
      await f.service.delete(f.data, origin);
      await f.service.delete(f.data, origin);
      assert.deepEqual(f.quota, [3, -3]);
      assert.equal(f.objects.size, 0);
      signatures.push(
        f.queries.map(
          /**
           * Proyecta cada elemento en la estructura requerida por la operación.
           * @param {*} query Valor de query utilizado por esta operación.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          (query) => Object.keys(query).sort(),
        ),
      );
    } finally {
      await f.close();
    }
  }
  assert.deepEqual(signatures[0], signatures[1]);
});

test('un consumidor distinto o un recurso diferente no puede leer, borrar ni conciliar el adjunto' /**
 * Verifica el comportamiento esperado del caso de prueba.
 * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
 */, async () => {
  const f = await fixture('service-connect');
  try {
    await f.upload();
    for (const operation of ['status', 'download', 'preview', 'delete', 'discard'])
      await assert.rejects(
        f.service[operation](f.data, 'service-platform'),
        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @param {Error} error Fallo recibido por la continuación.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        (error) => error.statusCode === 403,
      );
    await assert.rejects(
      f.service.status(
        {
          ...f.data,
          resourceCode : 'other',
        },
        'service-connect',
      ),
      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @param {Error} error Fallo recibido por la continuación.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (error) => error.statusCode === 403,
    );
    assert.equal(f.objects.size, 1);
    assert.deepEqual(f.quota, [3]);
  } finally {
    await f.close();
  }
});

/** Verifica que persistencia conserve metadatos explícitos y no atribuya archivos a un consumidor por defecto.
 * @returns {Promise<void>} Finaliza al comprobar el contrato canónico y rechazar registros incompletos.
 */
async function verifyCanonicalMetadata() {
  const filter     = { _id: 'attachment' };
  const record     = {
    _id           : 'attachment',
    originService : 'service-connect',
    resourceType  : 'email',
    resourceCode  : 'email-code',
    storageKey    : 'private/attachments/service-connect/attachment',
    digest        : 'f'.repeat(64),
    size          : 3,
    mime          : 'application/octet-stream',
    state         : 'ready',
    creationDate  : 100,
  };
  let stored       = record;
  const repository = createRepository({
    model : {
      /** @param {Object} input Identidad exacta que recibe el adaptador.
       * @returns {Object} Consulta de persistencia sin invocar almacenamiento.
       */
      findOne(input) {
        assert.equal(input, filter);
        return {
          /** @returns {Promise<Object|null>} Registro técnico simulado o ausencia real. */
          async lean() {
            return stored;
          },
        };
      },
    },
  });
  assert.deepEqual(await repository.findOne(filter), record);
  stored = null;
  assert.equal(await repository.findOne(filter), null);
  for (const field of [
    'originService',
    'resourceType',
    'resourceCode',
    'storageKey',
    'digest',
    'size',
    'mime',
    'state',
    'creationDate',
  ]) {
    stored = { ...record };
    delete stored[field];
    await assert.rejects(repository.findOne(filter), {
      statusCode      : 500,
      descriptionCode : 'INVALID_ATTACHMENT_RECORD',
    });
  }
}
test(
  'el repositorio exige metadatos canónicos sin inferir propiedad ni almacenamiento',
  verifyCanonicalMetadata,
);

test('los expedientes privados reconocen PDF y conservan propiedad por servicio y recurso', /** @returns {Promise<void>} Verifica el productor documental real con almacenamiento aislado. */ async () => {
  for (const actor of ['customer', 'supplier']) {
    const f = await fixture('service-' + actor);
    try {
      f.data.resourceType = actor + '-enrollment';
      f.data.size = Buffer.byteLength('%PDF-1.7\nfixture');
      assert.deepEqual(await f.upload('%PDF-1.7\nfixture'), {
        mime : 'application/pdf',
      });
      const state = await f.service.status(f.data, 'service-' + actor);
      assert.equal(state.mime, 'application/pdf');
      await assert.rejects(
        f.service.download(
          {
            ...f.data,
            resourceCode : 'OTHER',
          },
          'service-' + actor,
        ),
      );
      await assert.rejects(f.service.download(f.data, 'service-apigateway'));
    } finally {
      await f.close();
    }
  }
});
