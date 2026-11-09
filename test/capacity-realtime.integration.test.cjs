/** @file El consumo documental y su revisión se confirman atómicamente con el evento estándar. */
'use strict';
const test              = require('node:test');
const assert            = require('node:assert/strict');
const { fixture }       = require('./helpers/documents-fixture.cjs');
const { trustedScopes } = require('../server/modules/settings/policies/settings.policy');

test(
  'un fallo del outbox revierte la cuota y conserva la transacción exterior',
  { skip: !process.env.TEST_MONGOD_BINARY },
  /** @param {Object} t Recursos aislados. @returns {Promise<void>} Comprueba MongoDB real y hechos sin datos privados. */ async (
    t,
  ) => {
    const f = await fixture(t, { delegated: false });
    t.after(f.close);
    const model      = f.connection.model('FILES_SETTINGS');
    const repository = require('../server/modules/settings/repositories/settings.repository')({
      model,
      messaging  : f.messaging,
      getSession : f.unitOfWork.current,
    });
    const first      = await repository.adjustUsedSpace(20, trustedScopes.guest);
    assert.equal(first.data.usedSpace, 20);
    assert.equal(first.revision, 1);
    const event = await f.db
      .collection('TEST_OUTBOX')
      .findOne({ name: 'documents.settings.changed' });
    assert.deepEqual(event.data, {
      parameter : 'documents-settings',
      revision  : 1,
    });
    f.state.failEvent = true;
    await assert.rejects(repository.adjustUsedSpace(5, trustedScopes.guest), /OUTBOX_FAILED/);
    assert.equal((await model.findOne({ parameter: 'documents-settings' })).data.usedSpace, 20);
    assert.equal(
      await f.db.collection('TEST_OUTBOX').countDocuments({ name: 'documents.settings.changed' }),
      1,
    );
    f.state.failEvent = false;
    await assert.rejects(
      f.connection.transaction(
        /** @param {Object} session Unidad externa. @returns {Promise<void>} Revierte también un ajuste ya aceptado dentro de la unidad. */ async (
          session,
        ) => {
          await repository.adjustUsedSpace(5, trustedScopes.guest, { session });
          throw new Error('CANCELLED_LEDGER');
        },
      ),
      /CANCELLED_LEDGER/,
    );
    assert.equal((await model.findOne({ parameter: 'documents-settings' })).data.usedSpace, 20);
    assert.equal(
      await f.db.collection('TEST_OUTBOX').countDocuments({ name: 'documents.settings.changed' }),
      1,
    );
  },
);
