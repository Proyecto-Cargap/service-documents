/** @file Pruebas de comportamiento de contracts.test en service-documents. */
'use strict';
const test      = require('node:test');
const assert    = require('node:assert/strict');
const fs        = require('node:fs');
const path      = require('node:path');
const vm        = require('node:vm');
const contracts = require('../server/contracts/index');
/**
 * Ejecuta proxy dentro del flujo de contracts.test.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
/** @param {Array} entries Catálogo. @returns {Array} Catálogo íntegro. */
function identityCatalog(entries) {
  return entries;
}
/** @returns {Function} Doble del envoltorio. */
function delegateFactory() {
  return identityCatalog;
}
/** @returns {Object} Proxy de dependencias técnicas del catálogo. */
function proxy() {
  let value;

  /**
   * Ejecuta fn dentro del flujo de contracts.test.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  const fn = function () {
    return value;
  };
  value = new Proxy(fn, {
    /**
     * Obtiene el valor solicitado.
     * @param {string} target Valor de target utilizado por esta operación.
     * @param {string} key Clave del campo o recurso que se procesa.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    get(target, key) {
      if (key === 'then') return undefined;
      if (key === 'registerAction' && Object.hasOwn(target, key)) return target[key];
      if (key === Symbol.iterator)
        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @returns {void} Finaliza después de aplicar los efectos de la operación.
         */
        return function* () {};
      if (key === Symbol.toPrimitive)
        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @returns {string} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        return () => '';
      return value;
    },
    /**
     * Ejecuta apply dentro del flujo de contracts.test.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    apply() {
      return value;
    },

    /**
     * Ejecuta construct dentro del flujo de contracts.test.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    construct() {
      return value;
    },
  });
  return value;
}
test('service catalog exactly matches its current canonical contracts' /**
 * Verifica el comportamiento esperado del caso de prueba.
 * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
 */, async () => {
  const registrations = [],
    messaging         = proxy();

  /**
   * Ejecuta registerAction dentro del flujo de contracts.test.
   * @param {*} value Valor de value utilizado por esta operación.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  messaging.registerAction = (value) => registrations.push(value);
  const filename = path.resolve(__dirname, '../server/modules/catalog.js'),
    module       = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(filename, 'utf8'),
    {
      module,
      exports : module.exports,
      process,
      /**
       * Ejecuta require dentro del flujo de contracts.test.
       * @param {string} name Nombre del componente o recurso.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      require : (name) =>
        name.includes('document-delegation.service')
          ? { documentDelegation: delegateFactory }
          : name === '../contracts/index'
            ? contracts
            : name.endsWith('package.json')
              ? require('../package.json')
              : proxy(),
    },
    { filename },
  );
  const catalog = await module.exports.createCatalog({
    messaging,
    logger   : proxy(),
    env      : {},
    mongoose : proxy(),
  });
  assert.equal(typeof catalog.documentsLifecycle?.start, 'function');
  assert.equal(typeof catalog.documentsLifecycle?.close, 'function');
  await catalog.documentsLifecycle.start();
  await catalog.documentsLifecycle.close();
  const actual   = [...registrations, ...catalog]
    .map(
      /**
       * Proyecta cada elemento en la estructura requerida por la operación.
       * @param {*} item Valor de item utilizado por esta operación.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (item) => item.name,
    )
    .sort();
  const declared = contracts.manifest.endpoints
    .filter(
      /**
       * Determina si el elemento cumple el criterio de selección.
       * @param {*} item Valor de item utilizado por esta operación.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (item) => item.name !== 'health',
    )
    .map(
      /**
       * Proyecta cada elemento en la estructura requerida por la operación.
       * @param {*} item Valor de item utilizado por esta operación.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (item) => item.name,
    )
    .sort();
  assert.equal(new Set(actual).size, actual.length);
  assert.deepEqual(actual, declared);
  assert(!Object.hasOwn(contracts.manifest, 'version'));
  for (const entry of contracts.manifest.endpoints) {
    if (entry.kind === 'action') assert.match(entry.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert(entry.request && entry.response);
    assert(
      !/(?:communication|notification)-access|(?:communication|notification)-profiles|session-contact|communication-attachment/.test(
        entry.name,
      ),
    );
  }
});
test('discovery returns the same contract and rejects consumer-selected projections' /**
 * Verifica el comportamiento esperado del caso de prueba.
 * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
 */, async () => {
  const [entry] = contracts.catalog([]);
  const value   = await entry.handler({ data: {} });
  assert.equal(value.data.service, require('../package.json').name);
  assert.equal(value.statusCode, 200);
  assert.throws(
    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    () => entry.handler({ data: { consumer: 'chat' } }),

    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Error} error Fallo recibido por la continuación.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    (error) => error.statusCode === 400,
  );
  assert.equal(
    contracts.validate(
      { consumer: 'chat' },
      {
        type                 : 'object',
        additionalProperties : true,
      },
    ),
    false,
  );
});
test('outgoing actions use the same canonical names as the receiving catalog' /**
 * Verifica el comportamiento esperado del caso de prueba.
 * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
 */, async () => {
  const calls   = [];
  const client  = contracts.client({
    /**
     * Invoca el puerto remoto conservando el contexto y las opciones de entrega.
     * @param {...*} args Valor de args utilizado por esta operación.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    request     : async (...args) => calls.push(args),

    /**
     * Ejecuta sendCommand dentro del flujo de contracts.test.
     * @param {...*} args Valor de args utilizado por esta operación.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    sendCommand : async (...args) => calls.push(args),
  });
  const context = { user: { userCode: 'fixture' } };
  await client.request('service-intelligence', 'agent-get-list', {}, { context });
  await client.sendCommand('service-communication', 'chat-group-picture-update', { code: 'c' });
  assert.equal(calls[0][1], 'agent-get-list');
  assert.equal(calls[0][3].context, context);
  assert.equal(calls[1][1], 'chat-group-picture-update');
});

/**
 * Verifica la cobertura de DTO y el comportamiento de la frontera pública en todas las acciones.
 * @returns {Promise<void>} Finaliza tras comprobar registro, validación y serialización.
 */
test('cada acción declara DTO de entrada y salida en su dominio' /**
 * Aplica la operación local y devuelve su resultado al flujo que la invoca.
 * @returns {Promise<*>} Resultado de la operación; los fallos se propagan al flujo invocador.
 */, async () => {
  assert.deepEqual(
    Object.keys(contracts.actionDtos).sort(),
    contracts.manifest.endpoints
      .map(
        /**
         * Aplica la operación local y devuelve su resultado al flujo que la invoca.
         * @param {*} entry Valor utilizado por la operación.
         * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
         */
        (entry) => entry.name,
      )
      .sort(),
  );
  for (const definition of contracts.manifest.endpoints) {
    const dto = contracts.actionDtos[definition.name];
    assert(Object.isFrozen(dto));
    assert.match(definition.dto, /^server\/modules\/[a-z0-9-]+\/dtos\/[a-z0-9.-]+\.dto\.js$/);
    assert.equal(require(path.resolve(__dirname, '..', definition.dto))[definition.name], dto);
    assert.equal(dto.inputSchema, definition.request);
    assert(dto.outputSchema);
    assert.throws(
      /**
       * Aplica la operación local y devuelve su resultado al flujo que la invoca.
       * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
       */
      () => dto.input({ consumer: 'fixture' }),

      /**
       * Aplica la operación local y devuelve su resultado al flujo que la invoca.
       * @param {*} error Valor utilizado por la operación.
       * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
       */
      (error) => error.statusCode === 400,
    );
    assert.throws(
      /**
       * Aplica la operación local y devuelve su resultado al flujo que la invoca.
       * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
       */
      () => dto.input(null),

      /**
       * Aplica la operación local y devuelve su resultado al flujo que la invoca.
       * @param {*} error Valor utilizado por la operación.
       * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
       */
      (error) => error.statusCode === 400,
    );
  }
  let calls     = 0;
  const [entry] = contracts.catalog([
    {
      name    : 'health',
      kind    : 'action',

      /**
       * Ejecuta handler y devuelve el resultado al flujo que lo invoca.
       * @returns {Promise<*>} Resultado de la operación; los fallos se propagan al flujo invocador.
       */
      handler : async () => {
        calls++;
        return {
          statusCode      : '200',
          descriptionCode : 'OK',
          data            : { fixture: true },
          privateValue    : 'hidden',
        };
      },
    },
  ]);
  await assert.rejects(
    entry.handler({ data: { projection: 'consumer' } }),

    /**
     * Aplica la operación local y devuelve su resultado al flujo que la invoca.
     * @param {*} error Valor utilizado por la operación.
     * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
     */
    (error) => error.statusCode === 400,
  );
  assert.equal(calls, 0);
  assert.deepEqual(await entry.handler({ data: {} }), {
    statusCode      : 200,
    descriptionCode : 'OK',
    data            : { fixture: true },
  });
  assert.equal(calls, 1);
  const dto = contracts.actionDtos['service-contracts-get'];
  assert.throws(
    /**
     * Aplica la operación local y devuelve su resultado al flujo que la invoca.
     * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
     */
    () =>
      dto.output({
        statusCode      : 200,
        descriptionCode : 42,
        data            : {},
      }),

    /**
     * Aplica la operación local y devuelve su resultado al flujo que la invoca.
     * @param {*} error Valor utilizado por la operación.
     * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
     */
    (error) => error.statusCode === 500,
  );
  assert.throws(
    /**
     * Aplica la operación local y devuelve su resultado al flujo que la invoca.
     * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
     */
    () => dto.output({ statusCode: 700 }),

    /**
     * Aplica la operación local y devuelve su resultado al flujo que la invoca.
     * @param {*} error Valor utilizado por la operación.
     * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
     */
    (error) => error.statusCode === 500,
  );
  assert.deepEqual(
    dto.output({
      statusCode      : 403,
      descriptionCode : 'FORBIDDEN',
    }),
    {
      statusCode      : 403,
      descriptionCode : 'FORBIDDEN',
    },
  );
  const typed = contracts.manifest.endpoints.find(
    /**
     * Aplica la operación local y devuelve su resultado al flujo que la invoca.
     * @param {*} definition Valor utilizado por la operación.
     * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
     */
    (definition) => definition.successData && definition.successData.required?.length,
  );
  if (typed)
    assert.throws(
      /**
       * Aplica la operación local y devuelve su resultado al flujo que la invoca.
       * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
       */
      () =>
        contracts.actionDtos[typed.name].output({
          statusCode : 200,
          data       : {},
        }),

      /**
       * Aplica la operación local y devuelve su resultado al flujo que la invoca.
       * @param {*} error Valor utilizado por la operación.
       * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
       */
      (error) => error.statusCode === 500,
    );
});

/**
 * Comprueba que decorar acciones conserva los colaboradores de arranque y cierre del catálogo.
 * @returns {Promise<void>} Finaliza al verificar composiciones síncronas y asíncronas.
 */
test('el catálogo conserva su ciclo de vida y los descriptores de metadatos' /**
 * Aplica la operación local y devuelve su resultado al flujo que la invoca.
 * @returns {Promise<*>} Resultado de la operación; los fallos se propagan al flujo invocador.
 */, async () => {
  let starts      = 0;
  let closes      = 0;
  const lifecycle = {
    /**
     * Ejecuta start y devuelve el resultado al flujo que lo invoca.
     * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
     */
    start() {
      starts++;
    },
    /**
     * Ejecuta close y devuelve el resultado al flujo que lo invoca.
     * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
     */
    close() {
      closes++;
    },
  };
  const marker    = Symbol('trace');
  const entries   = [
    {
      name    : 'health',
      kind    : 'action',
      /**
       * Ejecuta handler y devuelve el resultado al flujo que lo invoca.
       * @returns {Promise<*>} Resultado de la operación; los fallos se propagan al flujo invocador.
       */
      handler : async () => ({ statusCode: 200 }),
    },
  ];
  Object.defineProperty(entries, 'documentsLifecycle', {
    value      : lifecycle,
    enumerable : false,
    writable   : false,
  });
  entries[marker] = { value: 'fixture' };
  for (const compose of [
    /**
     * Aplica la operación local y devuelve su resultado al flujo que la invoca.
     * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
     */
    () => entries,
    /**
     * Aplica la operación local y devuelve su resultado al flujo que la invoca.
     * @returns {Promise<*>} Resultado de la operación; los fallos se propagan al flujo invocador.
     */
    async () => entries,
  ]) {
    const result = await contracts.catalogFactory(compose)();
    assert.equal(result.documentsLifecycle, lifecycle);
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(result, 'documentsLifecycle'),
      Object.getOwnPropertyDescriptor(entries, 'documentsLifecycle'),
    );
    assert.equal(result[marker], entries[marker]);
    assert.notEqual(result[0], entries[0]);
    await assert.rejects(
      result[0].handler({ data: { consumer: 'fixture' } }),
      /**
       * Aplica la operación local y devuelve su resultado al flujo que la invoca.
       * @param {*} error Valor utilizado por la operación.
       * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
       */
      (error) => error.statusCode === 400,
    );
    await result.documentsLifecycle.start();
    await result.documentsLifecycle.close();
  }
  assert.equal(starts, 2);
  assert.equal(closes, 2);
});
