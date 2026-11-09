/** @file Inventarios consistentes y escritura por identidad/revisión sobre MongoDB transaccional real. */
'use strict';
const test                       = require('node:test');
const assert                     = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const fs                         = require('node:fs/promises');
const path                       = require('node:path');
const { fixture }                = require('./helpers/documents-fixture.cjs');
test(
  'manifiesto paginado coherente y precondiciones impiden sobrescribir otra identidad o subárbol',
  { skip: !process.env.TEST_MONGOD_BINARY },
  /** @param {Object} t Prueba. @returns {Promise<void>} Contratos y persistencia reales con S3 sintético. */ async (
    t,
  ) => {
    const f = await fixture(t);
    t.after(f.close);
    const root    = (await f.call('documents-repositories-get-list')).listItem.find(
      /** @param {Object} item Raíz. @returns {boolean} Espacio. */ (item) =>
        item.kind === 'workspace',
    );
    const folder  = await f.call('documents-folder-create', {
      repositoryId : root.id,
      name         : 'Documentos',
    });
    const entries = f.connection.collection('DOCUMENTS_ENTRIES');
    const sample  = await entries.findOne({ name: 'Documentos' });
    assert.ok(sample);
    // La carga de 10 mil entradas ejercita paginación real sin 10 mil RPC de preparación.
    const { ObjectId } = require('mongoose').Types;
    await entries.insertMany(
      Array.from(
        { length: 10000 },
        /** @param {*} unused Sin valor. @param {number} index Consecutivo. @returns {Object} Entrada válida. */ (
          _,
          index,
        ) => ({
          ...sample,
          _id      : new ObjectId(),
          type     : 'file',
          name     : `archivo-${index}.txt`,
          nameKey  : `archivo-${index}.txt`,
          parentId : sample._id,
          size     : 1,
          mimeType : 'text/plain',
          sha256   : null,
        }),
      ),
    );
    let first = await f.call('documents-repository-manifest-get', { repositoryId: root.id });
    assert.equal(first.items.length, 500);
    assert.ok(first.nextCursor);
    const ids = new Set(
      first.items.map(
        /** @param {Object} item Entrada. @returns {string} Identidad. */ (item) => item.id,
      ),
    );
    let page  = first;
    while (page.nextCursor) {
      page = await f.call('documents-repository-manifest-get', {
        repositoryId : root.id,
        cursor       : page.nextCursor,
      });
      assert.equal(page.revision, first.revision);
      for (const item of page.items) ids.add(item.id);
    }
    assert.equal(ids.size, 10001);
    assert.equal(
      (
        await f.call('documents-repository-manifest-get', {
          repositoryId  : root.id,
          knownRevision : first.revision,
        })
      ).notModified,
      true,
    );
    await f.call('documents-folder-create', {
      repositoryId : root.id,
      name         : 'Concurrente',
    });
    await assert.rejects(
      f.call('documents-repository-manifest-get', {
        repositoryId : root.id,
        cursor       : first.nextCursor,
      }),
      { statusCode: 409 },
    );
    await assert.rejects(
      f.call('documents-entry-delete', {
        entryId                    : folder.id,
        expectedRevision           : folder.revision,
        expectedRepositoryRevision : first.revision,
      }),
      { statusCode: 409 },
    );
    assert.equal(
      (await f.call('documents-entry-get-one', { entryId: folder.id })).item.id,
      folder.id,
    );
    const bytes = Buffer.from('abc'),
      sha256    = createHash('sha256').update(bytes).digest('hex'),
      filename  = path.join(f.root, randomUUID());
    await fs.writeFile(filename, bytes);
    const args = {
      repositoryId : root.id,
      fileName     : 'nuevo.txt',
      mimeType     : 'text/plain',
      byteLength   : 3,
      sha256,
    };
    const key  = randomUUID();
    await f.call('documents-file-upload-prepare', args, key);
    const uploaded = await f.call(
      'documents-file-upload',
      {
        ...args,
        tempFilePath : filename,
      },
      key,
    );
    assert.equal(uploaded.sha256, sha256);
    const prepared = await f.call('documents-entry-download-prepare', {
      entryId          : uploaded.id,
      expectedRevision : uploaded.revision,
    });
    assert.equal(prepared.sha256, sha256);
    assert.equal(prepared.revision, uploaded.revision);
    await assert.rejects(
      f.call('documents-entry-download-prepare', {
        entryId          : uploaded.id,
        expectedRevision : uploaded.revision + 1,
      }),
      { statusCode: 409 },
    );
    await assert.rejects(
      f.call('documents-file-upload-prepare', {
        ...args,
        overwrite        : true,
        entryId          : folder.id,
        expectedRevision : uploaded.revision,
      }),
      { statusCode: 409 },
    );
    f.state.revoked = true;
    await assert.rejects(f.call('documents-repository-manifest-get', { repositoryId: root.id }), {
      statusCode : 401,
    });
  },
);

test(
  'la precondición del subárbol protege hijos nuevos y cambios concurrentes sin depender de otras carpetas',
  { skip: !process.env.TEST_MONGOD_BINARY },
  /** @param {Object} t Prueba. @returns {Promise<void>} Verifica contratos, transacciones, outbox y autorización reales. */ async (
    t,
  ) => {
    const f = await fixture(t);
    t.after(f.close);
    const root        = (await f.call('documents-repositories-get-list')).listItem.find(
      /** @param {Object} item Repositorio. @returns {boolean} Raíz del workspace. */ (item) =>
        item.kind === 'workspace',
    );
    let folder        = await f.call('documents-folder-create', {
      repositoryId : root.id,
      name         : 'Origen',
    });
    const destination = await f.call('documents-folder-create', {
      repositoryId : root.id,
      name         : 'Destino',
    });
    /** @param {Object[]} nodes Entradas de la base conocida. @returns {string} Precondición calculada exclusivamente con la representación pública. */
    function hash(nodes) {
      return createHash('sha256')
        .update(
          JSON.stringify(
            nodes
              .map(
                /** @param {Object} item Entrada. @returns {Array} Identidad y revisión. */ (
                  item,
                ) => [item.id, item.revision],
              )
              .sort(
                /** @param {Array} left Primera entrada. @param {Array} right Segunda entrada. @returns {number} Orden binario canónico. */ (
                  left,
                  right,
                ) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0),
              ),
          ),
        )
        .digest('hex');
    }
    const oldHash = hash([folder]);
    let child     = await f.call('documents-folder-create', {
      repositoryId : root.id,
      parentId     : folder.id,
      name         : 'Hijo nuevo',
    });
    const before  = await f.call('documents-repository-manifest-get', { repositoryId: root.id });
    const events  = await f.connection.collection('TEST_OUTBOX').countDocuments();
    for (const [action, args] of [
      ['documents-entry-rename', { name: 'Rechazado' }],
      [
        'documents-entry-move',
        {
          targetRepositoryId : root.id,
          targetParentId     : destination.id,
        },
      ],
      ['documents-entry-delete', {}],
    ])
      await assert.rejects(
        f.call(action, {
          entryId             : folder.id,
          expectedRevision    : folder.revision,
          expectedSubtreeHash : oldHash,
          ...args,
        }),
        {
          statusCode      : 409,
          descriptionCode : 'DOCUMENT_SUBTREE_REVISION_CONFLICT',
        },
      );
    assert.equal(
      (await f.call('documents-repository-manifest-get', { repositoryId: root.id })).revision,
      before.revision,
    );
    assert.equal(await f.connection.collection('TEST_OUTBOX').countDocuments(), events);
    const currentHash = hash([folder, child]);
    await f.call('documents-folder-create', {
      repositoryId : root.id,
      name         : 'Cambio ajeno',
    });
    folder = await f.call('documents-entry-rename', {
      entryId             : folder.id,
      expectedRevision    : folder.revision,
      expectedSubtreeHash : currentHash,
      name                : 'Renombrado',
    });
    const beforeChildChange = hash([folder, child]);
    child = await f.call('documents-entry-rename', {
      entryId          : child.id,
      expectedRevision : child.revision,
      name             : 'Hijo cambiado',
    });
    await assert.rejects(
      f.call('documents-entry-delete', {
        entryId             : folder.id,
        expectedRevision    : folder.revision,
        expectedSubtreeHash : beforeChildChange,
      }),
      {
        statusCode      : 409,
        descriptionCode : 'DOCUMENT_SUBTREE_REVISION_CONFLICT',
      },
    );
    folder = await f.call('documents-entry-move', {
      entryId             : folder.id,
      expectedRevision    : folder.revision,
      expectedSubtreeHash : hash([folder, child]),
      targetRepositoryId  : root.id,
      targetParentId      : destination.id,
    });
    child = (await f.call('documents-entry-get-one', { entryId: child.id })).item;
    const args = {
      entryId             : folder.id,
      expectedRevision    : folder.revision,
      expectedSubtreeHash : hash([folder, child]),
    };
    f.state.failEvent = true;
    await assert.rejects(f.call('documents-entry-delete', args), /OUTBOX_FAILED/);
    f.state.failEvent = false;
    assert.equal(
      (await f.call('documents-entry-get-one', { entryId: child.id })).item.id,
      child.id,
    );
    f.state.revoked = true;
    await assert.rejects(f.call('documents-entry-delete', args), { statusCode: 401 });
    f.state.revoked = false;
    const result = await f.call('documents-entry-delete', args);
    assert.equal(result.deletedCount, 2);
  },
);
