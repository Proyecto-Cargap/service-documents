/** @file Regresiones del análisis de módulos sin uso: ciclos aislados, trabajadores y referencias no verificables. */
'use strict';
const test              = require('node:test');
const assert            = require('node:assert/strict');
const fs                = require('node:fs');
const os                = require('node:os');
const path              = require('node:path');
const { analyzeUnused } = require('../ops/check-unused.cjs');

/** Construye fuentes aisladas sin importar ni ejecutar sus módulos.
 * @param {Object<string,string>} sources Rutas y contenido del servicio mínimo.
 * @param {Function} verify Comprobaciones del grafo esperado.
 * @returns {void} Siempre elimina el directorio que pertenece a esta prueba.
 */
function fixture(sources, verify) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solid-unused-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ main: 'server/server.js' }));
    for (const [file, source] of Object.entries(sources)) {
      const filename = path.join(root, file);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, source);
    }
    verify(analyzeUnused(root));
  } finally {
    fs.rmSync(root, {
      recursive : true,
      force     : true,
    });
  }
}

/** @returns {void} Distingue módulos realmente cargados de ciclos que sólo se referencian entre sí o desde una prueba. */
function verifyOrphans() {
  fixture(
    {
      'server/server.js'           : "require('./active');",
      'server/active.js'           : "throw new Error('NO_EXECUTION');",
      'server/first.js'            : "require('./second');",
      'server/second.js'           : "require('./first');",
      'test/consumer.test.cjs'     : "require('../server/first');",
      'server/library/optional.js' : '',
    },
    /** @param {Object} result Grafo inspeccionado sin ejecutar el módulo activo.
     * @returns {void} Exige los dos componentes del ciclo inalcanzable y excluye bibliotecas opcionales.
     */
    (result) => {
      assert.deepEqual(
        result.findings.map(
          /** @param {Object} finding Hallazgo de módulo inalcanzable.
           * @returns {string} Ruta que debe eliminarse o incorporarse al flujo activo.
           */
          (finding) => finding.file,
        ),
        ['server/first.js', 'server/second.js'],
      );
    },
  );
}

/** @returns {void} Conserva trabajadores y sus colaboradores cuando la entrada declara la ruta de ejecución. */
function verifyWorkers() {
  fixture(
    {
      'server/server.js'      :
        "const path = require('node:path'); new Worker(path.join(__dirname, 'workers/job.js'));",
      'server/workers/job.js' : "require('../helper');",
      'server/helper.js'      : '',
    },
    /** @param {Object} result Grafo de entradas y colaboradores del trabajador.
     * @returns {void} No clasifica código cargado por Worker como archivo sin uso.
     */
    (result) => assert.equal(result.passed, true),
  );
}

/** @returns {void} Rechaza referencias rotas y cargas calculadas en lugar de presumir que acreditan uso. */
function verifyUnknownLoads() {
  fixture(
    {
      'server/server.js' : "require('./missing'); require(moduleName); new Worker(workerName);",
    },
    /** @param {Object} result Referencias cuya existencia no se puede acreditar.
     * @returns {void} Expone cada error estático con su regla correspondiente.
     */
    (result) =>
      assert.deepEqual(
        result.findings.map(
          /** @param {Object} finding Error de carga detectado.
           * @returns {string} Regla que impide aceptar el inventario incompleto.
           */
          (finding) => finding.rule,
        ),
        ['missing-runtime-import', 'unresolved-runtime-import', 'unresolved-worker-entry'],
      ),
  );
}
test('detecta ciclos sin entrada operativa y no cuenta pruebas como consumidores', verifyOrphans);
test('reconoce puntos de entrada de trabajadores sin ejecutar el servicio', verifyWorkers);
test('rechaza importaciones rotas o puntos de carga indeterminados', verifyUnknownLoads);
