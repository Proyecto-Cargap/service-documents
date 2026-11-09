/** @file Lecturas de ventanas documentales: instantánea Mongo, orden, límites y revocación reales. */
'use strict';
const test        = require('node:test');
const assert      = require('node:assert/strict');
const { fixture } = require('./helpers/documents-fixture.cjs');
const dto         = require('../server/modules/documents/dtos/documents.actions.dto')['documents-view-get'];
test(
  'página, total y revisiones comparten una instantánea; la siguiente lectura observa el cambio',
  { skip: !process.env.TEST_MONGOD_BINARY },
  /** @param {Object} t Ejecución. @returns {Promise<void>} Productor real sin servicios ni datos de instalación. */
  async (t) => {
    const f = await fixture(t);
    t.after(f.close);
    const root   = (await f.call('documents-repositories-get-list')).listItem.find(
      /** @param {Object} item Raíz pública. @returns {boolean} Espacio autorizado. */
      (item) => item.kind === 'workspace',
    );
    const folder = await f.call('documents-folder-create', {
      repositoryId : root.id,
      name         : 'Primero',
    });
    const query  = dto.input({
      favorites    : false,
      trash        : false,
      repositoryId : root.id,
      parentId     : null,
      selectedId   : folder.id,
      search       : '',
      type         : '',
      sort         : 'name',
      order        : 'asc',
      page         : 1,
      perPage      : 20,
      ancestors    : [],
    });
    /** @returns {Promise<Object>} La misma proyección y contrato consumidos por Platform. */
    async function read() {
      return dto.output({
        statusCode      : 200,
        descriptionCode : 'OK',
        data            : await f.service.getView(query),
      }).data;
    }
    await f.unitOfWork.run(
      /** @returns {Promise<void>} Una escritura concurrente no mezcla la selección y el listado. */
      async () => {
        const before = await read();
        await f.connection
          .getClient()
          .db(f.connection.name)
          .collection('DOCUMENTS_ENTRIES')
          .updateOne(
            { _id: f.unitOfWork.ids.parse(folder.id) },
            {
              $set : {
                name    : 'Después',
                nameKey : 'Después',
              },
              $inc : { revision: 1 },
            },
          );
        const same = await read();
        assert.deepEqual(same, before);
        assert.equal(same.listItem[0].name, same.selected.item.name);
        assert.equal(same.listItem[0].revision, same.selected.item.revision);
      },
    );
    const next = await read();
    assert.equal(next.listItem[0].name, 'Después');
    assert.equal(next.totalCount, 1);
    assert.equal(next.selected.item.revision, folder.revision + 1);
    const last = await f.service.getView({
      ...query,
      page : 20,
    });
    assert.equal(last.page, 1);
    assert.equal(last.listItem.length, 1);
    assert.throws(
      /** @returns {Object} El cliente no puede registrar filas como base autorizada. */
      () =>
        dto.input({
          ...query,
          records : next.listItem,
        }),
      { statusCode: 400 },
    );
    f.actor.policies = [];
    await assert.rejects(read, { statusCode: 403 });
  },
);

test(
  'raíces, metadatos y configuración comparten snapshot y publican hechos mínimos atómicos',
  { skip: !process.env.TEST_MONGOD_BINARY },
  /** @param {Object} t Prueba aislada. @returns {Promise<void>} Comprueba carreras de lectura y rollback del evento junto con la escritura. */ async (
    t,
  ) => {
    const f = await fixture(t, { delegated: false });
    t.after(f.close);
    const roots     = await f.call('documents-repositories-get-list');
    const root      = roots.listItem.find(
      /** @param {Object} item Raíz. @returns {boolean} Espacio activo. */
      (item) => item.kind === 'workspace',
    );
    const folder    = await f.call('documents-folder-create', {
      repositoryId : root.id,
      name         : 'Carpeta',
    });
    const pageQuery = {
      repositoryId : root.id,
      parentId     : null,
      page         : 1,
      perPage      : 20,
    };
    const initial   = await f.call('documents-settings-get');
    await f.unitOfWork.run(
      /** @returns {Promise<void>} Otro escritor confirma entre lecturas, sin mezclar dos estados. */
      async () => {
        const beforeRoots      = await f.service.getRepositories();
        const beforePage       = await f.service.getList(pageQuery);
        const beforeDetail     = await f.service.getOne({ entryId: folder.id });
        const beforeSettings   = await f.service.getSettings();
        const beforeReferences = await f.service.getReferences({ entryIds: [folder.id] });
        await f.db.collection('DOCUMENTS_REPOSITORIES').updateOne(
          { _id: f.unitOfWork.ids.parse(root.id) },
          {
            $inc : {
              usedSpace : 10,
              revision  : 1,
            },
          },
        );
        await f.db.collection('DOCUMENTS_ENTRIES').updateOne(
          { _id: f.unitOfWork.ids.parse(folder.id) },
          {
            $set : {
              name    : 'Renombrada',
              nameKey : 'Renombrada',
            },
            $inc : { revision: 1 },
          },
        );
        const model =
          f.connection.models.Settings ||
          Object.values(f.connection.models).find(
            /** @param {Object} value Modelo. @returns {boolean} Colección de parámetros. */
            (value) => value.schema.path('parameter'),
          );
        await f.db.collection(model.collection.name).updateOne(
          { parameter: 'documents-settings' },
          {
            $inc : { revision: 1 },
            $set : { 'data.trashRetentionDays': 40 },
          },
        );
        assert.deepEqual(await f.service.getRepositories(), beforeRoots);
        assert.deepEqual(await f.service.getList(pageQuery), beforePage);
        assert.deepEqual(await f.service.getOne({ entryId: folder.id }), beforeDetail);
        assert.deepEqual(await f.service.getSettings(), beforeSettings);
        assert.deepEqual(
          await f.service.getReferences({ entryIds: [folder.id] }),
          beforeReferences,
        );
      },
    );
    assert.equal(
      (await f.call('documents-entry-get-one', { entryId: folder.id })).item.name,
      'Renombrada',
    );
    assert.equal(
      (await f.call('documents-entry-references', { entryIds: [folder.id, 'f'.repeat(24)] }))
        .listItem[0].name,
      'Renombrada',
    );
    const settings = await f.call('documents-settings-get');
    assert.equal(settings.revision, initial.revision + 1);
    const baseline = await f.db.collection('TEST_OUTBOX').countDocuments();
    f.state.failEvent = true;
    await assert.rejects(
      f.call('documents-settings-update', {
        expectedRevision : settings.revision,
        data             : {
          ...settings.data,
          trashRetentionDays : 50,
        },
      }),
      /OUTBOX_FAILED/,
    );
    assert.deepEqual(await f.call('documents-settings-get'), settings);
    assert.equal(await f.db.collection('TEST_OUTBOX').countDocuments(), baseline);
    f.state.failEvent = false;
    const saved = await f.call('documents-settings-update', {
      expectedRevision : settings.revision,
      data             : {
        ...settings.data,
        trashRetentionDays : 50,
      },
    });
    assert.equal(saved.revision, settings.revision + 1);
    await assert.rejects(
      f.call('documents-settings-update', {
        expectedRevision : settings.revision,
        data             : settings.data,
      }),
      { statusCode: 409 },
    );
    const events = await f.db
      .collection('TEST_OUTBOX')
      .find({ name: { $in: ['documents.repository.changed', 'documents.settings.changed'] } })
      .toArray();
    assert(
      events.some(
        /** @param {Object} event Hecho. @returns {boolean} Configuración confirmada. */
        (event) =>
          event.name === 'documents.settings.changed' && event.data.revision === saved.revision,
      ),
    );
    const { validate } = require('../server/contracts/action-dto');
    const schemas      = require('../server/contracts/service.json').publishedEvents;
    for (const event of events) {
      assert(validate(event.data, schemas[event.name]));
      assert(!Object.hasOwn(event.data, 'data'));
      assert(!Object.hasOwn(event.data, 'name'));
    }
    f.actor.policies = [];
    assert.deepEqual((await f.call('documents-repositories-get-list')).listItem, []);
    await assert.rejects(f.call('documents-entry-get-one', { entryId: folder.id }), {
      statusCode : 403,
    });
    await assert.rejects(f.call('documents-settings-get'), { statusCode: 403 });
    assert.deepEqual(await f.call('documents-entry-references', { entryIds: [folder.id] }), {
      listItem : [],
    });
  },
);
