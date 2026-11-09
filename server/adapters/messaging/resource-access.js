/** @file Consulta las facultades vigentes del recurso sin aceptar permisos del cliente. */
'use strict';
const { ApplicationError } = require('../../shared/application-error');
/** @param {Object} options Mensajería acreditada. @returns {Function} Consulta de acceso por referencia e identidad. */
function createResourceAccess({ messaging }) {
  /** @param {Object} subject Referencia validada. @param {Object} actor Identidad capturada por el servidor. @returns {Promise<Object>} Alcance y facultades efectivos; propaga indisponibilidad. */
  return async (subject, actor) => {
    const result = await messaging.request(
      subject.service,
      'resource-access-check',
      {
        references : [
          {
            domain : subject.domain,
            code   : subject.code,
          },
        ],
      },
      { context: actor },
    );
    if (result?.statusCode !== 200)
      throw new ApplicationError(
        result?.statusCode >= 400 ? result.statusCode : 503,
        result?.descriptionCode || 'DOCUMENT_RESOURCE_ACCESS_UNAVAILABLE',
      );
    const grant = result.data?.items?.[0];
    if (
      !Array.isArray(result.data?.items) ||
      result.data.items.length !== 1 ||
      grant?.code !== subject.code ||
      grant.domain !== subject.domain ||
      typeof grant.allowed !== 'boolean' ||
      !Array.isArray(grant.resourcePermissions)
    )
      throw new ApplicationError(503, 'DOCUMENT_RESOURCE_ACCESS_UNAVAILABLE');
    if (
      !grant.allowed ||
      (subject.service !== 'service-support' &&
        !['allWorkspaces', actor.workspace].includes(grant.workspace))
    )
      throw new ApplicationError(403, 'FORBIDDEN');
    const view  = grant.resourcePermissions.includes(subject.domain + '.view');
    const write = view && grant.resourcePermissions.includes(subject.domain + '.update');
    return {
      workspace    : grant.workspace,
      capabilities : {
        view,
        create : write || grant.resourcePermissions.includes(subject.domain + '.create'),
        update : write,
        delete : write,
      },
    };
  };
}
module.exports = { createResourceAccess };
