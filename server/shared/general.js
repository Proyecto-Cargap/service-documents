/** @file Funciones puras de formato, ordenación y búsqueda; no acceden a infraestructura. */
'use strict';
const { ApplicationError } = require('./application-error');
/**
 * Ejecuta pad dentro del flujo de general.
 * @param {*} value Valor de value utilizado por esta operación.
 * @param {number|string} size Valor de size utilizado por esta operación.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function pad(value, size) {
  return String(value).padStart(size, '0');
}
/**
 * Resuelve getSortQuery aplicando los filtros y colaboradores del módulo.
 * @param {string} field Campo utilizado por la operación.
 * @param {*} [sort] Valor de sort utilizado por esta operación.
 * @param {*} [order] Valor de order utilizado por esta operación.
 * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function getSortQuery(field, sort = null, order = null) {
  const selected = sort || field;
  if (typeof selected !== 'string' || !/^[A-Za-z][A-Za-z0-9_.]*$/.test(selected))
    throw new TypeError('INVALID_SORT');
  if (order !== null && !['asc', 'desc', '1', '-1', 1, -1].includes(order))
    throw new TypeError('INVALID_SORT');
  return { [selected]: order || 'asc' };
}
/**
 * Ejecuta escapeRegex dentro del flujo de general.
 * @param {*} value Valor de value utilizado por esta operación.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function escapeRegex(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * Valida la paginación pública y convierte la página de base uno a base cero para persistencia.
 * @param {Object} [input] Entrada con page y perPage opcionales; admite valores numéricos de transporte.
 * @returns {{page: number, perPage: number}} Página interna y tamaño; cero indica ausencia de límite.
 * @throws {ApplicationError} INVALID_PAGINATION si un valor no es entero o está fuera de rango.
 */
function getPagination(input = {}) {
  for (const key of ['page', 'perPage']) {
    if (
      input[key] !== undefined &&
      (!Number.isInteger(Number(input[key])) ||
        Number(input[key]) < (key === 'page' ? 1 : 0) ||
        Number(input[key]) > 10000)
    )
      throw new ApplicationError(400, 'INVALID_PAGINATION');
  }
  const perPage = parseInt(input.perPage) || 0;
  const page    = (parseInt(input.page) || 1) - 1;
  return {
    page,
    perPage,
  };
}

module.exports = {
  pad,
  getSortQuery,
  escapeRegex,
  getPagination,
};

/** Paginación pública acotada; las lecturas internas completas usan un contrato separado.
 * @param {Object} [input] Entrada que se procesa con las reglas del módulo.
 * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function getPublicPagination(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ApplicationError(400, 'INVALID_PAGINATION');
  const values = {};
  for (const [key, fallback, maximum] of [
    ['page', 1, 10000],
    ['perPage', 20, 100],
  ]) {
    const value = input[key] === undefined ? fallback : input[key];
    if (
      (typeof value !== 'number' && typeof value !== 'string') ||
      (typeof value === 'string' && !/^\d+$/.test(value)) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) < 1 ||
      Number(value) > maximum
    )
      throw new ApplicationError(400, 'INVALID_PAGINATION');
    values[key] = Number(value);
  }
  return {
    page    : values.page - 1,
    perPage : values.perPage,
  };
}
module.exports.getPublicPagination = getPublicPagination;
