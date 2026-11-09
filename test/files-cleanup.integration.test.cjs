/** @file Borrado de Files con MongoDB real, exclusión, recuperación y cuota transaccional. */
'use strict';
const test                     = require('node:test');
const assert                   = require('node:assert/strict');
const { randomUUID }           = require('node:crypto');
const mongoose                 = require('mongoose');
const { fixture }              = require('./helpers/documents-fixture.cjs');
const { createMongoChanges }   = require('../server/library/work/mongo-changes');
const { createReactiveWorker } = require('../server/library/work/reactive-worker');
/** @param {number} ms Plazo de prueba. @returns {Promise<void>} Espera ajena al trabajador. */
function delay(ms) {
  return new Promise(
    /** @param {Function} resolve Continuación. @returns {void} Programa el plazo. */ (resolve) =>
      setTimeout(resolve, ms),
  );
}
/** @param {Function} check Condición observable. @returns {Promise<void>} Espera acotada del arnés. */
async function until(check) {
  const end = Date.now() + 7000;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('FILES_CLEANUP_TIMEOUT');
    await delay(20);
  }
}
test(
  'Files excluye consumidores, conserva reintentos tras reiniciar y rechaza confirmaciones de leases antiguos',
  { skip: !process.env.TEST_MONGOD_BINARY },
  /** @param {Object} t Recursos aislados. @returns {Promise<void>} Usa persistencia y servicios reales. */
  async (t) => {
    const f                  = await fixture(t, { delegated: false });
    const model              = require('../server/modules/files/models/files.model')({
      mongoose : {
        Schema : mongoose.Schema,
        model  : f.connection.model.bind(f.connection),
      },
    });
    const repository         = require('../server/modules/files/repositories/files-storage.repository')({
      model,
    });
    const settingsModel      = f.connection.model('FILES_SETTINGS');
    const settingsRepository =
      require('../server/modules/settings/repositories/settings.repository')({
        model      : settingsModel,
        messaging  : f.messaging,
        getSession : f.unitOfWork.current,
      });
    const logger             = { /** @returns {void} No registra contenido de archivos. */ error() {} };
    let deletes = 0,
      reads     = 0,
      fail      = false,
      pause,
      entered;
    const storage = {
      /** @param {Object} input Clave y cancelación. @returns {Promise<void>} Proveedor aislado que permite controlar carreras. */
      async delete(input) {
        assert.ok(input.signal instanceof AbortSignal);
        deletes++;
        if (fail) {
          fail = false;
          throw new Error('STORAGE_UNAVAILABLE');
        }
        entered?.();
        if (pause) await pause;
      },
    };
    /** @returns {Object} Instancia del dominio con su propio ciclo de recuperación. */
    function service() {
      return require('../server/modules/files/services/files-storage.service')({
        repository,
        storage,
        settingsRepository,
        env : { BUCKET: 'fixture' },
        logger,
      });
    }
    let workers = [];
    t.after(
      /** @returns {Promise<void>} Cierra observadores antes del replica set. */ async () => {
        for (const worker of workers) await worker.close();
        await f.close();
      },
    );
    /** @returns {Promise<void>} Abre dos streams independientes y espera su disponibilidad. */
    async function start() {
      const sources = [];
      workers = [1, 2].map(
        /** @param {number} index Instancia. @returns {Object} Consumidor independiente. */ (
          index,
        ) => {
          const source = createMongoChanges({
            connection   : f.connection,
            collections  : [model.collection.name],
            updateFields : ['storageState', 'cleanupUntil'],
            logger,
            component    : `files-${index}`,
          });
          sources.push(source);
          const domain = service();
          return createReactiveWorker({
            source,
            logger,
            component : `files-${index}`,
            /** @returns {Promise<number|undefined>} Cuenta consultas de planificación. */ nextAt() {
              reads++;
              return repository.nextDeletionAt();
            },
            /** @param {Object} options Cierre cooperativo. @returns {Promise<void>} Recupera sólo operaciones acreditadas. */ tick(
              options,
            ) {
              return domain.recover(options);
            },
          });
        },
      );
      for (const worker of workers) worker.start();
      await until(
        /** @returns {boolean} Ambos streams disponibles. */ () =>
          sources.every(
            /** @param {Object} source Fuente. @returns {boolean} Disponibilidad. */ (source) =>
              source.ready,
          ),
      );
      await delay(120);
    }
    /** @param {number} cleanupUntil Vencimiento. @returns {Promise<Object>} Registro y cuota que representan una carga ya aceptada. */
    async function create(cleanupUntil = 0) {
      await settingsModel.updateOne(
        { parameter: 'documents-settings' },
        { $inc: { 'data.usedSpace': 10 } },
      );
      return model.create({
        storageId     : randomUUID(),
        workspace     : 'W1',
        userCreate    : 'U1',
        userAssigned  : '',
        originService : 'service-customer',
        resourceType  : 'customer',
        resourceCode  : 'C1',
        storageState  : 'deleting',
        fileName      : 'fixture',
        path          : 'fixture',
        module        : 'customer',
        scope         : 'private',
        totalSize     : 10,
        variants      : [
          {
            label : 'original',
            key   : randomUUID(),
            size  : 10,
          },
        ],
        cleanupUntil,
      });
    }
    /** @returns {Promise<number>} Cuota durable. */
    async function used() {
      return (await settingsModel.findOne({ parameter: 'documents-settings' }).lean()).data
        .usedSpace;
    }
    await service().start();
    await start();
    const baseline = reads,
      began        = Date.now(),
      idle         = Number(process.env.WORK_IDLE_MS || 300);
    await delay(idle);
    assert.equal(reads, baseline);
    console.log(`files_idle_ms=${Date.now() - began}; reads=${reads - baseline}`);
    const first = await create(Date.now() + 300);
    await delay(100);
    assert.equal(deletes, 0);
    await until(
      /** @returns {Promise<boolean>} Borrado confirmado. */ async () =>
        (await repository.get(first.storageId)).storageState === 'deleted',
    );
    assert.equal(deletes, 1);
    assert.equal(await used(), 0);
    await model.updateOne({ storageId: first.storageId }, { $set: { fileNameReal: 'metadato' } });
    await delay(120);
    const stable = reads;
    await delay(100);
    assert.equal(reads, stable);
    fail = true;
    const retry = await create();
    await until(
      /** @returns {Promise<boolean>} Reintento durable. */ async () =>
        (await repository.get(retry.storageId)).cleanupUntil > Date.now() + 30000,
    );
    for (const worker of workers) await worker.close();
    await start();
    assert.equal(deletes, 2, 'reiniciar respeta el vencimiento');
    await model.updateOne(
      { storageId: retry.storageId },
      { $set: { cleanupUntil: Date.now() + 150 } },
    );
    await until(
      /** @returns {Promise<boolean>} Reintento completado. */ async () =>
        (await repository.get(retry.storageId)).storageState === 'deleted',
    );
    assert.equal(deletes, 3);
    assert.equal(await used(), 0);
    for (const worker of workers) await worker.close();
    const stale = await create();
    let release;
    pause = new Promise(
      /** @param {Function} resolve Permite terminar al proveedor antiguo. @returns {void} Conserva la continuación. */ (
        resolve,
      ) => {
        release = resolve;
      },
    );
    const waiting  = new Promise(
      /** @param {Function} resolve Acredita el inicio del efecto externo. @returns {void} Conserva la continuación. */ (
        resolve,
      ) => {
        entered = resolve;
      },
    );
    const removal  = service().remove(
      {
        fileId       : stale.storageId,
        resourceType : 'customer',
        resourceCode : 'C1',
      },
      'service-customer',
    );
    const rejected = assert.rejects(removal, { message: 'FILE_CLEANUP_LEASE_LOST' });
    await waiting;
    await model.updateOne(
      { storageId: stale.storageId },
      {
        $set : {
          cleanupOwner : 'new-owner',
          cleanupUntil : Date.now() + 360000,
        },
      },
    );
    release();
    await rejected;
    assert.equal(await used(), 10, 'el propietario vencido no libera cuota');
    assert.equal((await repository.get(stale.storageId)).cleanupOwner, 'new-owner');
    pause = undefined;
    entered = undefined;
    await model.updateOne({ storageId: stale.storageId }, { $set: { cleanupUntil: 0 } });
    await service().remove(
      {
        fileId       : stale.storageId,
        resourceType : 'customer',
        resourceCode : 'C1',
      },
      'service-customer',
    );
    assert.equal(await used(), 0);
    await service().remove(
      {
        fileId       : stale.storageId,
        resourceType : 'customer',
        resourceCode : 'C1',
      },
      'service-customer',
    );
    assert.equal(await used(), 0, 'confirmar nuevamente conserva cuota');
  },
);
