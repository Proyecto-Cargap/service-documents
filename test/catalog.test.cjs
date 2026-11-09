/** @file Construye todas las capacidades productivas para detectar exports incompletos antes del despliegue. */
'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');

test('el catálogo compone Files y Documents sin abrir conexiones', /** @returns {void} La composición real debe conservar sus capacidades y ciclo de vida. */ () => {
  const catalog = require('../server/modules/catalog').createCatalog({
    messaging : {},
    env       : {
      END_POINT        : 'http://127.0.0.1:50000',
      ENV_NAME         : 'test',
      AWS_REGION       : 'us-east-1',
      BUCKET_DOCUMENTS : 'fixture',
    },
    logger    : { /** @returns {void} Registro sin datos de negocio. */ error() {} },
  });
  assert.ok(
    catalog.some(
      /** @param {Object} entry Acción registrada. @returns {boolean} Conserva la capacidad de archivos. */ (
        entry,
      ) => entry.name === 'files-create',
    ),
  );
  assert.ok(
    catalog.some(
      /** @param {Object} entry Acción registrada. @returns {boolean} Conserva la lectura documental. */ (
        entry,
      ) => entry.name === 'documents-repository-manifest-get',
    ),
  );
  assert.equal(typeof catalog.documentsLifecycle.start, 'function');
  assert.equal(typeof catalog.documentsLifecycle.close, 'function');
});
