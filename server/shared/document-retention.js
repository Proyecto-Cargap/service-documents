/** @file Retención de papelera en días; se captura al enviar cada subárbol. */
'use strict';
const { ApplicationError } = require('./application-error');
/**
 * Ejecuta trashRetentionDays dentro del flujo de document-retention.
 * @param {Object} data Datos de entrada de la operación.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function trashRetentionDays(data) {
  const value = data?.trashRetentionDays === undefined ? 30 : data.trashRetentionDays;
  if (!Number.isSafeInteger(value) || value < 1 || value > 3650)
    throw new ApplicationError(400, 'INVALID_DOCUMENT_TRASH_RETENTION');
  return value;
}
module.exports = { trashRetentionDays };
