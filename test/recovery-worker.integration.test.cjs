/** @file Recuperación documental real por Change Streams, vencimientos y leases entre dos trabajadores. */
'use strict';
const test                     = require('node:test');
const assert                   = require('node:assert/strict');
const { fixture }              = require('./helpers/documents-fixture.cjs');
const { createMongoChanges }   = require('../server/library/work/mongo-changes');
const { createReactiveWorker } = require('../server/library/work/reactive-worker');
const {
  documentRecoveryRepository,
} = require('../server/modules/documents/repositories/recovery.repository');
/** @param {number} ms Plazo de la prueba. @returns {Promise<void>} Espera controlada que no pertenece al trabajador. */
function delay(ms) {
  return new Promise(
    /** @param {Function} resolve Continuación. @returns {void} Programa el plazo de prueba. */ (
      resolve,
    ) => setTimeout(resolve, ms),
  );
}
/** @param {Function} check Aserción eventual. @returns {Promise<void>} Espera acotada de una transición observable, nunca implementación de producción. */
async function until(check) {
  const end = Date.now() + 7000;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('DOCUMENT_RECOVERY_TIMEOUT');
    await delay(20);
  }
}
test(
  'dos trabajadores esperan cambios, respetan leases y recuperan papelera y reintentos tras reiniciar',
  { skip: !process.env.TEST_MONGOD_BINARY },
  /** @param {Object} t Ciclo de prueba. @returns {Promise<void>} Ejercita repositorios, servicio, Change Streams y efectos aislados. */
  async (t) => {
    const f          = await fixture(t, { delegated: false });
    const models     = {
      operations   : f.connection.model('DOCUMENTS_OPERATIONS'),
      entries      : f.connection.model('DOCUMENTS_ENTRIES'),
      repositories : f.connection.model('DOCUMENTS_REPOSITORIES'),
    };
    const root       = (await f.call('documents-repositories-get-list')).listItem.find(
      /** @param {Object} item Raíz. @returns {boolean} Espacio de la prueba. */ (item) =>
        item.kind === 'workspace',
    );
    const repository = documentRecoveryRepository(models);
    const logger     = { /** @returns {void} No conserva datos del dominio. */ error() {} };
    let reads = 0,
      deletes = 0,
      fail    = false;
    const remove = f.objects.delete.bind(f.objects);
    /** @param {string} key Clave conocida. @returns {boolean} Efecto aislado con fallo controlable. */
    f.objects.delete = (key) => {
      deletes++;
      if (fail) {
        fail = false;
        throw new Error('STORAGE_UNAVAILABLE');
      }
      return remove(key);
    };
    let workers = [];
    t.after(
      /** @returns {Promise<void>} Cierra observadores antes de sus datos. */ async () => {
        for (const worker of workers) await worker.close();
        await f.close();
      },
    );
    /** @returns {Promise<void>} Arranca dos consumidores reales con reclamación compartida en MongoDB. */
    async function start() {
      const sources = [];
      workers = [1, 2].map(
        /** @param {number} index Instancia. @returns {Object} Trabajador independiente. */
        (index) => {
          const source = createMongoChanges({
            connection   : f.connection,
            collections  : Object.values(models).map(
              /** @param {Object} model Modelo. @returns {string} Colección. */ (model) =>
                model.collection.name,
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
            component    : `documents-${index}`,
          });
          sources.push(source);
          return createReactiveWorker({
            source,
            logger,
            component : `documents-${index}`,
            /** @returns {Promise<number|undefined>} Cuenta sólo consultas de planificación. */ nextAt() {
              reads++;
              return repository.nextAt();
            },
            /** @param {Object} options Continuidad. @returns {Promise<void>} Dominio real sin principal del usuario. */ tick(
              options,
            ) {
              return f.local.run(
                {},
                /** @returns {Promise<void>} Usa sólo las capacidades técnicas del trabajador. */ () =>
                  f.service.recoverOnce(options),
              );
            },
          });
        },
      );
      for (const worker of workers) worker.start();
      await until(
        /** @returns {boolean} Streams acreditados. */ () =>
          sources.every(
            /** @param {Object} source Fuente. @returns {boolean} Lista. */ (source) =>
              source.ready,
          ),
      );
      await delay(120);
    }
    await start();
    const baseline = reads,
      idle         = Number(process.env.WORK_IDLE_MS || 300),
      began        = Date.now();
    await delay(idle);
    assert.equal(reads, baseline);
    console.log(`documents_idle_ms=${Date.now() - began}; reads=${reads - baseline}`);
    await models.repositories.updateOne(
      { _id: root.id },
      { $set: { name: 'Metadato sin trabajo' } },
    );
    await delay(100);
    assert.equal(reads, baseline, 'metadatos ajenos al vencimiento no despiertan al trabajador');
    f.objects.set('known-key', { content: Buffer.from('fixture') });
    const future    = Date.now() + 300;
    const operation = await models.operations.create({
      repositoryId : root.id,
      workspace    : root.workspace,
      userCreate   : 'U1',
      kind         : 'cleanup',
      state        : 'cleanup',
      keys         : ['known-key'],
      leaseUntil   : future,
      leaseToken   : 'previous-instance',
    });
    await delay(100);
    assert.equal(deletes, 0, 'respeta el lease de otra instancia');
    await until(
      /** @returns {Promise<boolean>} Terminación durable. */ async () =>
        (await models.operations.findById(operation._id).lean()).state === 'complete',
    );
    assert.equal(deletes, 1, 'la reclamación atómica excluye el segundo trabajador');
    fail = true;
    const retry = await models.operations.create({
      repositoryId : root.id,
      workspace    : root.workspace,
      userCreate   : 'U1',
      kind         : 'cleanup',
      state        : 'cleanup',
      keys         : ['retry-key'],
    });
    await until(
      /** @returns {Promise<boolean>} Fallo conserva vencimiento de reintento. */ async () =>
        (await models.operations.findById(retry._id).lean()).leaseUntil > Date.now() + 5000,
    );
    for (const worker of workers) await worker.close();
    await start();
    assert.equal(deletes, 2, 'reiniciar no adelanta un reintento futuro');
    await models.operations.updateOne(
      { _id: retry._id },
      { $set: { leaseUntil: Date.now() + 150 } },
    );
    await until(
      /** @returns {Promise<boolean>} Reintento confirmado. */ async () =>
        (await models.operations.findById(retry._id).lean()).state === 'complete',
    );
    assert.equal(deletes, 3);
    const folder = await f.call('documents-folder-create', {
      repositoryId : root.id,
      name         : 'Papelera',
    });
    await f.call('documents-entry-delete', {
      entryId          : folder.id,
      expectedRevision : folder.revision,
    });
    await models.entries.updateOne({ _id: folder.id }, { $set: { purgeAfter: Date.now() + 150 } });
    await until(
      /** @returns {Promise<boolean>} Purga efectiva en el vencimiento conocido. */ async () =>
        !(await models.entries.findById(folder.id).lean()),
    );
  },
);
