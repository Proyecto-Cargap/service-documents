/** @file Pruebas del estándar de alineación, nomenclatura y agrupación del código. */
'use strict';
const test                 = require('node:test');
const assert               = require('node:assert/strict');
const path                 = require('node:path');
const acorn                = require('acorn');
const { formatSource }     = require('../ops/format-code.cjs');
const { checkConventions } = require('../ops/code-conventions.cjs');

/**
 * Comprueba alineación, estructura e idempotencia sin modificar claves ni valores.
 * @returns {Promise<void>} Finaliza al verificar los objetos JavaScript y JSON.
 */
async function verifyAlignment() {
  const filename  = path.resolve(__dirname, '../server/contracts/example.js');
  const source    =
    "const aliases = { 'short': 'a', 'much-longer-key': 'https://example.test/a:b', nested: { a: 1, longer: 2 } };";
  const formatted = await formatSource(source, filename);
  assert.equal(await formatSource(formatted, filename), formatted);
  const ast        = acorn.parse(formatted, {
    ecmaVersion : 'latest',
    locations   : true,
  });
  const properties = ast.body[0].declarations[0].init.properties;
  const columns    = properties.map(
    /**
     * Proyecta cada elemento en la estructura requerida por la operación.
     * @param {*} property Valor de property utilizado por esta operación.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    (property) => {
      const lineStart = formatted.lastIndexOf('\n', property.key.end) + 1;
      return formatted.indexOf(':', property.key.end) - lineStart;
    },
  );
  assert.equal(new Set(columns).size, 1);
  assert.equal(properties[1].value.value, 'https://example.test/a:b');
  const declarations = await formatSource(
    'const short = 1; const muchLongerName = 2; let selected = 3;',
    filename,
  );
  assert.equal(
    new Set(
      declarations
        .trim()
        .split('\n')
        .map(
          /**
           * Proyecta cada elemento en la estructura requerida por la operación.
           * @param {*} line Valor de line utilizado por esta operación.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          (line) => line.indexOf('='),
        ),
    ).size,
    1,
  );
  assert.equal(await formatSource(declarations, filename), declarations);
  const json       = {
    short  : 'a',
    longer : {
      a      : 1,
      longer : 2,
    },
  };
  const serialized = await formatSource(JSON.stringify(json), filename.replace(/\.js$/, '.json'));
  assert.deepEqual(JSON.parse(serialized), json);
  assert.equal(await formatSource(serialized, filename.replace(/\.js$/, '.json')), serialized);
}

test('los objetos tienen claves alineadas, valores intactos y formato estable', verifyAlignment);

/**
 * Comprueba que las reglas señalan nombres y ubicaciones que incumplen el estándar.
 * @returns {void} Finaliza al verificar nombres de clases, funciones, variables y archivos.
 */
function verifyConventions() {
  const options  = {
    ecmaVersion : 'latest',
    locations   : true,
  };
  const filename = path.resolve(__dirname, '../server/modules/example/services/example.service.js');
  const valid    = acorn.parse(
    'class ExampleService {} const exampleService = new ExampleService(); function createExample() {}',
    options,
  );
  assert.deepEqual(checkConventions(valid, filename), []);
  const invalid = acorn.parse(
    'class wrong_class {} const wrong_name = 1; function wrong_function() {}',
    options,
  );
  assert.equal(checkConventions(invalid, filename).length, 3);
  const invalidMethod = acorn.parse('class ExampleService { wrong_method() {} }', options);
  assert(
    checkConventions(invalidMethod, filename).some(
      /**
       * Comprueba si el elemento satisface la condición.
       * @param {Error} error Fallo recibido por la continuación.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (error) => error.includes('método'),
    ),
  );
  assert(
    checkConventions(valid, path.resolve(__dirname, '../server/modules/leaked.js')).some(
      /**
       * Comprueba si el elemento satisface la condición.
       * @param {Error} error Fallo recibido por la continuación.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (error) => error.includes('dominio'),
    ),
  );
}

test('la nomenclatura y la agrupación rechazan desviaciones del estándar', verifyConventions);
