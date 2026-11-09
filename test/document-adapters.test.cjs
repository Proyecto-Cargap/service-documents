/** @file Pruebas de comportamiento de document-adapters.test en service-documents. */
'use strict';
const test                    = require('node:test');
const assert                  = require('node:assert/strict');
const { Readable }            = require('node:stream');
const { documentStorage }     = require('../server/adapters/storage/document-storage');
const { documentPersistence } = require('../server/adapters/mongodb/document-persistence');
test('document storage normalizes metadata, missing objects and content independently of SDK responses' /**
 * Verifica el comportamiento esperado del caso de prueba.
 * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
 */, async () => {
  const calls   = [];
  const storage = documentStorage({
    bucket  : 'private',
    storage : {
      /**
       * Ejecuta headObject dentro del flujo de document-adapters.test.
       * @param {Object} input Entrada que se procesa con las reglas del módulo.
       * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      headObject   : async (input) => {
        if (input.Key === 'missing') throw Object.assign(new Error(), { name: 'NoSuchKey' });
        if (input.Key === 'offline') throw Object.assign(new Error(), { name: 'NetworkError' });
        return {
          ContentLength : 3,
          Metadata      : {
            checksum  : 'hash',
            operation : 'op',
          },
        };
      },
      /**
       * Resuelve getObject aplicando los filtros y colaboradores del módulo.
       * @param {Object} input Entrada que se procesa con las reglas del módulo.
       * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      getObject    : async (input) => ({
        Body :
          input.Key === 'stream'
            ? Readable.from([Buffer.from('abc')])
            : {
                /**
                 * Ejecuta transformToByteArray dentro del flujo de document-adapters.test.
                 * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                 */
                transformToByteArray : async () => Buffer.from('abc'),
              },
      }),
      /**
       * Ejecuta putObject dentro del flujo de document-adapters.test.
       * @param {...*} args Valor de args utilizado por esta operación.
       * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      putObject    : async (...args) => calls.push(args),

      /**
       * Ejecuta deleteObject dentro del flujo de document-adapters.test.
       * @param {Object} input Entrada que se procesa con las reglas del módulo.
       * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      deleteObject : async (input) => calls.push(input),
    },
  });
  assert.deepEqual(await storage.head('file'), {
    size      : 3,
    checksum  : 'hash',
    operation : 'op',
  });
  assert.equal(await storage.head('missing'), null);
  await assert.rejects(storage.head('offline'));
  for (const key of ['stream', 'sdk']) assert.equal((await storage.read(key)).toString(), 'abc');
  const signal = AbortSignal.timeout(1000);
  await storage.put({
    key       : 'file',
    content   : Buffer.from('abc'),
    mimeType  : 'text/plain',
    checksum  : 'hash',
    operation : 'op',
    signal,
  });
  assert.deepEqual(calls[0][0].Metadata, {
    checksum  : 'hash',
    operation : 'op',
  });
  assert.equal(calls[0][0].IfNoneMatch, '*');
  assert.equal(calls[0][1].abortSignal, signal);
  await storage.delete('file');
  assert.deepEqual(calls[1], {
    Bucket : 'private',
    Key    : 'file',
  });
});
test('persistence preserves domain errors and maps commit uncertainty without treating it as success' /**
 * Verifica el comportamiento esperado del caso de prueba.
 * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
 */, async () => {
  const session = {};
  let failure;
  const persistence = documentPersistence({
    mongoose   : {
      /** @returns {void} Registra opciones del adaptador en el doble. */
      set() {},
      Types : {
        ObjectId : class {
          /**
           * Inicializa la instancia con las dependencias y opciones recibidas.
           * @param {*} value Valor de value utilizado por esta operación.
           */
          constructor(value) {
            this.value = value;
          }
        },
      },
    },
    connection : {
      /**
       * Ejecuta transaction dentro del flujo de document-adapters.test.
       * @param {Function} work Valor de work utilizado por esta operación.
       * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      transaction : async (work) => {
        if (failure) throw failure;
        return work(session);
      },
      db          : {
        /**
         * Ejecuta admin dentro del flujo de document-adapters.test.
         * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        admin : () => ({
          /**
           * Ejecuta command dentro del flujo de document-adapters.test.
           * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          command : async () => ({
            setName                      : 'rs',
            logicalSessionTimeoutMinutes : 30,
          }),
        }),
      },
    },
  });
  assert.equal(
    await persistence.run(
      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @param {*} value Valor de value utilizado por esta operación.
       * @returns {number} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (value) => {
        assert.equal(value, session);
        return 42;
      },
    ),
    42,
  );
  await persistence.verify();
  assert.equal(persistence.ids.parse('id').value, 'id');
  failure = Object.assign(new Error(), { code: 11000 });
  await assert.rejects(
    persistence.run(
      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @returns {void} Finaliza después de aplicar los efectos de la operación.
       */
      () => {},
    ),

    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {*} e Valor de e utilizado por esta operación.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    (e) => e.statusCode === 409,
  );
  failure = {
    /**
     * Evalúa la condición expresada por hasErrorLabel.
     * @param {*} label Valor de label utilizado por esta operación.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    hasErrorLabel : (label) => label === 'UnknownTransactionCommitResult',
  };
  await assert.rejects(
    persistence.run(
      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @returns {void} Finaliza después de aplicar los efectos de la operación.
       */
      () => {},
    ),

    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {*} e Valor de e utilizado por esta operación.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    (e) => e.uncertain && e.descriptionCode === 'DOCUMENT_WRITE_UNCERTAIN',
  );
});

test('el almacén de objetos conserva streaming, cifrado y escrituras condicionales' /**
 * Verifica el comportamiento esperado del caso de prueba.
 * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
 */, async () => {
  const { objectStorage } = require('../server/adapters/storage/object-storage');
  const calls             = [];
  const stream            = Readable.from(['contenido']);
  const adapter           = objectStorage({
    storage : {
      /**
       * Ejecuta putObject dentro del flujo de document-adapters.test.
       * @param {Object} input Entrada que se procesa con las reglas del módulo.
       * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
       */
      putObject    : async (input) => {
        calls.push(input);
      },
      /**
       * Resuelve getObject aplicando los filtros y colaboradores del módulo.
       * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      getObject    : async () => ({
        Body          : stream,
        ContentLength : 9,
        ContentType   : 'text/plain',
      }),
      /**
       * Ejecuta headObject dentro del flujo de document-adapters.test.
       * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
       */
      headObject   : async () => {
        throw Object.assign(new Error(), { $metadata: { httpStatusCode: 404 } });
      },
      /**
       * Ejecuta deleteObject dentro del flujo de document-adapters.test.
       * @param {Object} input Entrada que se procesa con las reglas del módulo.
       * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
       */
      deleteObject : async (input, options) => {
        calls.push({
          input,
          options,
        });
      },
    },
  });
  await adapter.put({
    bucket       : 'privado',
    key          : 'archivo',
    content      : stream,
    mimeType     : 'text/plain',
    size         : 9,
    metadata     : { owner: 'contacto' },
    onlyIfAbsent : true,
    encrypt      : true,
  });
  assert.equal(calls[0].Body, stream);
  assert.equal(calls[0].IfNoneMatch, '*');
  assert.equal(calls[0].ServerSideEncryption, 'AES256');
  const read = await adapter.read({
    bucket : 'privado',
    key    : 'archivo',
  });
  assert.equal(read.content, stream);
  assert.equal(read.size, 9);
  assert.equal(
    await adapter.head({
      bucket : 'privado',
      key    : 'ausente',
    }),
    null,
  );
  const controller = new AbortController();
  await adapter.delete({
    bucket : 'privado',
    key    : 'archivo',
    signal : controller.signal,
  });
  assert.deepEqual(calls[1], {
    input   : {
      Bucket : 'privado',
      Key    : 'archivo',
    },
    options : { abortSignal: controller.signal },
  });
});

test('Files acepta otros dominios con la misma regla de pertenencia al recurso' /**
 * Verifica el comportamiento esperado del caso de prueba.
 * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
 */, async () => {
  const createStorage = require('../server/modules/files/services/files-storage.service');
  const data          = {
    fileId       : '00000000-0000-4000-8000-000000000001',
    resourceType : 'agent-picture',
    resourceCode : 'agent-1',
  };
  const storage       = createStorage({
    env        : { BUCKET: 'private' },
    repository : {
      /**
       * Obtiene el valor solicitado.
       * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      get : async () => ({
        ...data,
        originService : 'service-intelligence',
        storageState  : 'deleted',
      }),
    },
  });
  for (const resourceType of ['agent-picture', 'chat-group-picture', 'document-picture']) {
    data.resourceType = resourceType;
    assert.deepEqual(
      await storage.remove(
        {
          ...data,
          visibility       : 'public',
          image            : false,
          generateVariants : false,
        },
        'service-intelligence',
      ),
      {},
    );
  }
  await assert.rejects(
    storage.remove(data, 'service-connect'),
    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Error} error Fallo recibido por la continuación.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    (error) => error.descriptionCode === 'FILE_DOMAIN_MISMATCH',
  );
});
