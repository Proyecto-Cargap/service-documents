/** @file Vencimientos documentales conocidos: journal, papelera y bajas de recursos, sin barrer pendientes por intervalo. */
'use strict';
/** @param {Object} models Modelos propios de Documents. @returns {Object} Consulta técnica del siguiente vencimiento sin exponer datos del dominio. */
function documentRecoveryRepository({ operations, entries, repositories }) {
  return {
    /** @returns {Promise<number|undefined>} Fecha del trabajo más próximo o ausencia de pendientes. */
    async nextAt() {
      const [operation, entry, resource] = await Promise.all([
        operations
          .findOne({
            erased : { $ne: true },
            state  : { $in: ['pending', 'cleanup', 'abandoned'] },
          })
          .sort({
            leaseUntil : 1,
            _id        : 1,
          })
          .select({ leaseUntil: 1 })
          .lean(),
        entries
          .findOne({
            erased     : { $ne: true },
            state      : 'trashed',
            purgeAfter : { $gt: 0 },
            $expr      : { $eq: ['$_id', '$trashRootId'] },
          })
          .sort({
            purgeAfter : 1,
            _id        : 1,
          })
          .select({ purgeAfter: 1 })
          .lean(),
        repositories.exists({
          erased                 : { $ne: true },
          kind                   : 'resource',
          resourceCleanupPending : true,
        }),
      ]);
      const dates                        = [];
      if (operation) dates.push(operation.leaseUntil || 0);
      if (entry) dates.push(entry.purgeAfter);
      if (resource) dates.push(0);
      return dates.length ? Math.min(...dates) : undefined;
    },
  };
}
module.exports = { documentRecoveryRepository };
