/** @file Contrato del origen público explícito y de las referencias canónicas de archivos. */
'use strict';
const test                                = require('node:test');
const assert                              = require('node:assert/strict');
const { endpointOrigin, fileResourceUrl } = require('../server/shared/endpoint-origin');

/** @returns {void} Los archivos públicos requieren un origen completo sin credenciales o componentes de navegación. */
function verifyOrigins() {
  assert.equal(endpointOrigin('https://files.example.test'), 'https://files.example.test');
  assert.equal(endpointOrigin('http://127.0.0.1:4200'), 'http://127.0.0.1:4200');
  assert.equal(
    fileResourceUrl('https://files.example.test', 'public', 'picture.webp'),
    'https://files.example.test/files/public/picture.webp',
  );
  for (const value of [
    'files.example.test',
    '//files.example.test',
    'http://files.example.test',
    'https://user:password@files.example.test',
    'https://files.example.test/path',
    'https://files.example.test?query=1',
    'https://files.example.test#fragment',
  ]) {
    /** @returns {string} La configuración inválida debe rechazarse antes de formar una URL de recurso. */
    function invalidOrigin() {
      return endpointOrigin(value);
    }
    assert.throws(invalidOrigin, { code: 'INVALID_END_POINT' });
  }
}
test(
  'valida orígenes explícitos y rechaza formatos sin esquema o con navegación adicional',
  verifyOrigins,
);
