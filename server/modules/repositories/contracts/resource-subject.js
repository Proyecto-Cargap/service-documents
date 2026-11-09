/** @file Referencias documentales estables y capacidades derivadas del dominio propietario. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
/** @param {Object} subject Referencia pública. @returns {Object} Referencia admitida sin campos adicionales. */
function resourceSubject(subject) {
  if (
    !subject ||
    Object.keys(subject).some(
      /** @param {string} key Campo recibido. @returns {boolean} Campo desconocido. */
      (key) => !['service', 'domain', 'code'].includes(key),
    ) ||
    !(
      (subject.service === 'service-projects' && subject.domain === 'work-item') ||
      (subject.service === 'service-support' &&
        ['ticket', 'ticket-internal'].includes(subject.domain))
    ) ||
    typeof subject.code !== 'string' ||
    !subject.code.trim() ||
    subject.code.length > 100
  )
    throw new ApplicationError(400, 'INVALID_DOCUMENT_SUBJECT');
  return {
    service : subject.service,
    domain  : subject.domain,
    code    : subject.code,
  };
}
/** @param {Object} subject Referencia validada. @returns {string} Clave estructural sin dependencia de workspace. */
function resourceNamespace(subject) {
  const value = resourceSubject(subject);
  return JSON.stringify([value.service, value.domain, value.code]);
}
module.exports = {
  resourceSubject,
  resourceNamespace,
};
