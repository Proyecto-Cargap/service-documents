/** @file Adaptador S3; el cliente y los comandos se proporcionan desde la composición. */
'use strict';
/**
 * Compone createS3Storage con las dependencias recibidas y devuelve su interfaz.
 * @param {Object} options Colaboradores u opciones: client, commands.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function createS3Storage({ client, commands }) {
  const storage = {};
  for (const operation of [
    'PutObject',
    'GetObject',
    'DeleteObject',
    'DeleteObjects',
    'HeadObject',
    'ListObjectsV2',
    'CopyObject',
  ]) {
    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @param {Object} options Opciones que delimitan el comportamiento de la operación.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    storage[operation[0].toLowerCase() + operation.slice(1)] = (input, options) =>
      client.send(new commands[`${operation}Command`](input), options);
  }
  return Object.freeze(storage);
}
module.exports = { createS3Storage };
