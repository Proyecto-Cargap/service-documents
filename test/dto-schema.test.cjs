/** @file Conformidad del validador de esquemas: alternativas, límites y unicidad estructural. */
'use strict';
const test         = require('node:test');
const assert       = require('node:assert/strict');
const { validate } = require('../server/contracts/action-dto');
test('las alternativas, patrones y arreglos únicos conservan la semántica declarada' /**
 * Aplica la operación local y devuelve su resultado al flujo que la invoca.
 * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
 */, () => {
  assert.equal(
    validate('abc', {
      type    : 'string',
      pattern : '^a',
    }),
    true,
  );
  assert.equal(
    validate('other', {
      type    : 'string',
      pattern : '^a',
    }),
    false,
  );
  assert.equal(validate(1, { oneOf: [{ type: 'number' }, { type: 'integer' }] }), false);
  assert.equal(validate('x', { oneOf: [{ type: 'number' }, { type: 'string' }] }), true);
  assert.equal(validate(true, { anyOf: [{ type: 'number' }, { type: 'string' }] }), false);
  assert.equal(validate(4, { allOf: [{ type: 'integer' }, { minimum: 5 }] }), false);
  const schema = {
    type        : 'array',
    minItems    : 1,
    uniqueItems : true,
    items       : { type: 'object' },
  };
  assert.equal(validate([], schema), false);
  assert.equal(
    validate(
      [
        {
          a : 1,
          b : 2,
        },
        {
          b : 2,
          a : 1,
        },
      ],
      schema,
    ),
    false,
  );
  assert.equal(validate([{ a: 1 }, { a: 2 }], schema), true);
});
