/** @file Registro administrativo de plantillas y anexos; las solicitudes nunca aportan rutas. */
'use strict';
const fs                   = require('node:fs');
const path                 = require('node:path');
const { ApplicationError } = require('../../shared/application-error');
/**
 * Resuelve loadRegistry aplicando los filtros y colaboradores del módulo.
 * @param {*} [env] Valor de env utilizado por esta operación.
 * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function loadRegistry(env = process.env) {
  try {
    if (!env.PDF_CONFIG_FILE || !path.isAbsolute(env.PDF_CONFIG_FILE)) throw new Error();
    const registry = JSON.parse(fs.readFileSync(env.PDF_CONFIG_FILE, 'utf8'));
    if (
      !registry.assetRoot ||
      !path.isAbsolute(registry.assetRoot) ||
      !registry.issuer ||
      typeof registry.issuer !== 'object' ||
      Array.isArray(registry.issuer) ||
      typeof registry.issuer.name !== 'string' ||
      !registry.issuer.name.trim() ||
      registry.issuer.name.length > 200 ||
      typeof registry.locale !== 'string' ||
      !Intl.DateTimeFormat.supportedLocalesOf([registry.locale]).length ||
      !/^[A-Z]{3}$/.test(registry.currency) ||
      typeof registry.timeZone !== 'string' ||
      !registry.timeZone ||
      !registry.templates ||
      typeof registry.templates !== 'object' ||
      Array.isArray(registry.templates) ||
      (registry.annexes !== undefined &&
        (typeof registry.annexes !== 'object' ||
          !registry.annexes ||
          Array.isArray(registry.annexes)))
    )
      throw new Error();
    new Intl.DateTimeFormat(registry.locale, {
      timeZone : registry.timeZone,
    }).format(0);
    new Intl.NumberFormat(registry.locale, {
      style    : 'currency',
      currency : registry.currency,
    });
    return {
      ...registry,
      assetRoot : fs.realpathSync(registry.assetRoot),
      annexes   : registry.annexes || {},
    };
  } catch {
    throw new ApplicationError(503, 'PDF_CONFIGURATION_REQUIRED');
  }
}
/**
 * Ejecuta approvedAsset dentro del flujo de pdf-registry.
 * @param {*} registry Valor de registry utilizado por esta operación.
 * @param {*} relative Valor de relative utilizado por esta operación.
 * @param {*} extension Valor de extension utilizado por esta operación.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function approvedAsset(registry, relative, extension) {
  try {
    if (
      typeof relative !== 'string' ||
      !relative ||
      path.isAbsolute(relative) ||
      relative.includes('\\') ||
      relative.split('/').some(
        /**
         * Comprueba si el elemento satisface la condición.
         * @param {*} part Valor de part utilizado por esta operación.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        (part) => !part || part === '.' || part === '..',
      ) ||
      !relative.endsWith(extension)
    )
      throw new Error();
    const real = fs.realpathSync(path.join(registry.assetRoot, relative));
    if (!real.startsWith(registry.assetRoot + path.sep) || !fs.statSync(real).isFile())
      throw new Error();
    return real;
  } catch {
    throw new ApplicationError(503, 'PDF_APPROVED_ASSET_UNAVAILABLE');
  }
}
/**
 * Ejecuta approvedRoots dentro del flujo de pdf-registry.
 * @param {*} [env] Valor de env utilizado por esta operación.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function approvedRoots(env = process.env) {
  return env.PDF_CONFIG_FILE ? [loadRegistry(env).assetRoot] : [];
}
module.exports = {
  loadRegistry,
  approvedAsset,
  approvedRoots,
};
