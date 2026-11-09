/** @file Implementación de endpoint-origin en service-documents. */
'use strict';

/** Valida un origen HTTPS explícito; admite HTTP únicamente para desarrollo en loopback.
 * @param {string} value Origen público sin credenciales, ruta, consulta ni fragmento.
 * @returns {string} Origen normalizado por el estándar URL.
 * @throws {Error} INVALID_END_POINT cuando el valor no declara un origen autorizado.
 */
function endpointOrigin(value) {
  try {
    if (
      typeof value !== 'string' ||
      !value ||
      value.trim() !== value ||
      /\s/.test(value) ||
      value.startsWith('//') ||
      value.includes('\\')
    )
      throw new Error();
    const url   = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw Object.assign(new Error('END_POINT debe ser un origen HTTPS explícito'), {
      code : 'INVALID_END_POINT',
    });
  }
}

/**
 * Ejecuta fileResourceUrl dentro del flujo de endpoint-origin.
 * @param {*} endpoint Valor de endpoint utilizado por esta operación.
 * @param {string|symbol} scope Alcance solicitado o marcador interno de confianza.
 * @param {string} name Nombre del componente o recurso.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function fileResourceUrl(endpoint, scope, name) {
  if (
    ![scope, name].every(
      /**
       * Comprueba la condición requerida para cada elemento.
       * @param {*} value Valor de value utilizado por esta operación.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (value) =>
        typeof value === 'string' &&
        value &&
        !/[\/\\?#\u0000-\u001f]/.test(value) &&
        value !== '.' &&
        value !== '..',
    )
  )
    throw Object.assign(new Error('Invalid public file reference'), {
      code : 'INVALID_FILE_REFERENCE',
    });
  return new URL(
    '/files/' + encodeURIComponent(scope) + '/' + encodeURIComponent(name),
    endpointOrigin(endpoint),
  ).href;
}

module.exports = {
  endpointOrigin,
  fileResourceUrl,
};
