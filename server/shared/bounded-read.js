/** @file Recorrido interno completo con consultas acotadas y orden estable elegido por el llamador. */
'use strict';
const { ApplicationError } = require('./application-error');
/**
 * Resuelve readAll aplicando los filtros y colaboradores del módulo.
 * @param {*} readPage Valor de readPage utilizado por esta operación.
 * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
async function readAll(readPage) {
  const listItem = [];
  let totalCount;
  for (let page = 0; page < 10000; page++) {
    const result = await readPage(page, 100);
    if (
      !result ||
      !Array.isArray(result.listItem) ||
      !Number.isSafeInteger(result.totalCount) ||
      result.totalCount < 0 ||
      (totalCount !== undefined && result.totalCount !== totalCount) ||
      result.listItem.length !== Math.min(100, Math.max(0, result.totalCount - listItem.length))
    )
      throw new ApplicationError(409, 'PAGINATION_CHANGED');
    totalCount = result.totalCount;
    listItem.push(...result.listItem);
    if (listItem.length === totalCount)
      return {
        listItem,
        totalCount,
      };
  }
  throw new ApplicationError(400, 'COLLECTION_TOO_LARGE');
}
module.exports = { readAll };
