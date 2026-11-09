/** @file Escrituras documentales con hecho mínimo en el mismo commit de MongoDB. */
'use strict';
const { validate } = require('../../contracts/action-dto');
const schemas      = require('../../contracts/service.json').publishedEvents;
/** @param {Object} dependencies Modelo propio, mensajería y sesión exterior. @returns {Function} Escritura y publicación indivisibles. */
function documentChanges({ model, messaging, resource, getSession }) {
  /** @param {Function} write Escritura autorizada. @param {Object} supplied Sesión del caso de uso. @param {boolean} erased Baja física. @returns {Promise<Object>} Resultado original tras confirmar su hecho durable. */
  async function commit(write, supplied, erased = false) {
    const session = supplied || getSession?.();
    if (!session)
      return model.db.transaction(
        /** @param {Object} active Transacción exclusiva. @returns {Promise<Object>} Reintento sin efectos externos. */
        (active) => commit(write, active, erased),
      );
    const item = await write(session);
    if (!item) return item;
    if (resource === 'settings' && item.parameter !== 'documents-settings') return item;
    const data =
      resource === 'repository'
        ? {
            repositoryId : String(item._id),
            workspace    : item.workspace,
            kind         : item.kind,
            ownerCode    : item.ownerCode || '',
            revision     : item.revision,
            erased       : erased || item.erased === true,
          }
        : {
            parameter : item.parameter,
            revision  : item.revision || 0,
          };
    const name = 'documents.' + resource + '.changed';
    if (!validate(data, schemas[name])) throw new TypeError('INVALID_DOCUMENT_CHANGE');
    await messaging.publishEvent(name, data, {
      session,
      context : {},
    });
    return item;
  }
  return commit;
}
module.exports = { documentChanges };
