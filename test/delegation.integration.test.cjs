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
const { startIsolatedMongo }     = require('./helpers/isolated-mongo.cjs');
const contracts                  = require('../server/contracts');
const { fixture }                = require('./helpers/documents-fixture.cjs');

test(
  'recibos, revisiones, cuotas y archivos conservan aislamiento y no duplican escrituras',
  { skip: !process.env.TEST_MONGOD_BINARY },
  /** @param {Object} t Ejecución. @returns {Promise<void>} Aceptación integral sin infraestructura real. */ async (
    t,
  ) => {
    const f = await fixture(t);
    t.after(f.close);
    const roots = await f.call('documents-repositories-get-list');
    const root  = roots.listItem.find(
      /** @param {Object} item Raíz. @returns {boolean} Espacio concreto. */ (item) =>
        item.kind === 'workspace',
    );
    const key = randomUUID(),
      input   = {
        repositoryId : root.id,
        name         : 'Carpeta',
      };
    const repeated = await Promise.all(
      Array.from(
        { length: 6 },
        /** @returns {Promise<Object>} Reintento concurrente de una sola intención. */ () =>
          f.call('documents-folder-create', input, key),
      ),
    );
    for (const item of repeated) assert.deepEqual(item, repeated[0]);
    assert.equal(await f.db.collection('DOCUMENTS_OPERATION_RECEIPTS').countDocuments({}), 1);
    await assert.rejects(
      f.call(
        'documents-folder-create',
        {
          ...input,
          name : 'Distinta',
        },
        key,
      ),
      { descriptionCode: 'IDEMPOTENCY_KEY_CONFLICT' },
    );
    const folder = repeated[0];
    await assert.rejects(
      f.call('documents-entry-rename', {
        entryId          : folder.id,
        name             : 'Otro',
        expectedRevision : 99,
      }),
      { statusCode: 409 },
    );
    const metadata  = {
      repositoryId : root.id,
      parentId     : folder.id,
      fileName     : 'texto.txt',
      mimeType     : 'text/plain',
      byteLength   : 3,
      sha256       : createHash('sha256').update('abc').digest('hex'),
    };
    const uploadKey = randomUUID();
    await f.call('documents-file-upload-prepare', metadata, uploadKey);
    const file = path.join(f.root, randomUUID());
    await fs.writeFile(file, 'abc');
    const uploaded = await f.call(
      'documents-file-upload',
      {
        ...metadata,
        tempFilePath : file,
      },
      uploadKey,
    );
    assert.equal(uploaded.name, 'texto.txt');
    await fs.writeFile(file, 'abc');
    assert.deepEqual(
      await f.call(
        'documents-file-upload',
        {
          ...metadata,
          tempFilePath : file,
        },
        uploadKey,
      ),
      uploaded,
    );
    assert.equal(f.state.puts, 1);
    assert.deepEqual(await f.call('documents-upload-status', { idempotencyKey: uploadKey }), {
      state : 'complete',
      item  : uploaded,
    });
    assert.equal(
      (await f.call('documents-entry-get-one', { entryId: uploaded.id })).item.name,
      'texto.txt',
    );
    assert.equal(
      (await f.call('documents-favorite-create', { entryId: uploaded.id })).isFavorite,
      true,
    );
    assert.equal((await f.call('documents-favorites-get-list')).totalCount, 1);
    assert.equal(
      (await f.call('documents-favorite-delete', { entryId: uploaded.id })).isFavorite,
      false,
    );
    const renamed = await f.call('documents-entry-rename', {
      entryId          : uploaded.id,
      name             : 'nuevo.txt',
      expectedRevision : uploaded.revision,
    });
    const moved   = await f.call('documents-entry-move', {
      entryId            : uploaded.id,
      targetRepositoryId : root.id,
      targetParentId     : null,
      expectedRevision   : renamed.revision,
    });
    assert.equal(moved.parentId, null);
    assert.equal(
      (await f.call('documents-entry-download-prepare', { entryId: moved.id })).byteLength,
      3,
    );
    const deleteKey = randomUUID(),
      deletion      = {
        entryId          : moved.id,
        expectedRevision : moved.revision,
      };
    const deleted = await f.call('documents-entry-delete', deletion, deleteKey);
    assert.equal(deleted.deletedCount, 1);
    assert.deepEqual(await f.call('documents-entry-delete', deletion, deleteKey), deleted);
    const trash = await f.call('documents-trash-get-list', { repositoryId: root.id });
    assert.equal(trash.totalCount, 1);
    const restored = await f.call('documents-entry-restore', {
      entryId          : moved.id,
      expectedRevision : trash.listItem[0].revision,
    });
    assert.equal(restored.name, 'nuevo.txt');
    const settings        = await f.call('documents-settings-get');
    const updatedSettings = await f.call('documents-settings-update', {
      data             : {
        ...settings.data,
        trashRetentionDays : 45,
      },
      expectedRevision : settings.revision,
    });
    assert.equal(updatedSettings.revision, settings.revision + 1);
    await assert.rejects(
      f.call('documents-settings-update', {
        data             : settings.data,
        expectedRevision : settings.revision,
      }),
      { statusCode: 409 },
    );
    const beforeRollback = await f.db.collection('DOCUMENTS_OPERATION_RECEIPTS').countDocuments({});
    f.state.failEvent = true;
    await assert.rejects(
      f.call('documents-folder-create', {
        repositoryId : root.id,
        name         : 'Rollback',
      }),
      /OUTBOX_FAILED/,
    );
    f.state.failEvent = false;
    assert.equal(
      await f.db.collection('DOCUMENTS_OPERATION_RECEIPTS').countDocuments({}),
      beforeRollback,
    );
    assert.equal(
      (
        await f.call('documents-entries-get-list', {
          repositoryId : root.id,
          search       : 'Rollback',
        })
      ).totalCount,
      0,
    );
    f.actor.workspace = 'W2';
    f.actor.delegation = undefined;
    const other = (await f.call('documents-repositories-get-list')).listItem.find(
      /** @param {Object} item Raíz. @returns {boolean} Espacio ajeno. */ (item) =>
        item.kind === 'workspace',
    );
    f.actor.workspace = 'W1';
    f.actor.delegation = {
      grantCode : 'G1',
      clientId  : 'C1',
    };
    await assert.rejects(f.call('documents-entries-get-list', { repositoryId: other.id }), {
      statusCode : 403,
    });
    f.state.revoked = true;
    await assert.rejects(f.call('documents-folder-create', input, key), { statusCode: 401 });
  },
);
