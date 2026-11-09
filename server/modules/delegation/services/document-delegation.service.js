/** @file Aplica identidad vigente y recibos transaccionales a las acciones documentales canónicas. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
/** @param {Object} dependencies Contexto, RPC, unidad de trabajo, contratos y consulta de recursos. @returns {Function} Envoltura de acciones. */
function documentDelegation({ messaging, unitOfWork, manifest, documents, present }) {
  /** @param {Array<Object>} catalog Catálogo del dominio. @returns {Array<Object>} Catálogo con ejecución delegada acreditada. */
  return (catalog) =>
    catalog.map(
      /** @param {Object} entry Acción canónica. @returns {Object} Acción acreditada. */ (
        entry,
      ) => {
        const spec = manifest.endpoints.find(
          /** @param {Object} endpoint Contrato. @returns {boolean} Coincide. */ (endpoint) =>
            endpoint.name === entry.name,
        )?.delegation;
        if (!spec) return entry;
        return {
          ...entry,
          /** @param {Object} message Entrada validada. @returns {Promise<Object>} Resultado confirmado o error público. */
          async handler(message) {
            const incoming = messaging.getContext();
            if (!incoming.delegation) return entry.handler(message);
            const response  = await messaging.request(
              'service-security',
              'oauth-principal-resolve',
              {
                ...incoming.delegation,
                workspace : incoming.workspace,
              },
            );
            const principal = response?.data;
            if (
              response?.statusCode !== 200 ||
              principal?.userCode !== incoming.user?.userCode ||
              principal?.workspace !== incoming.workspace
            )
              throw new ApplicationError(401, 'OAUTH_CONNECTION_REVOKED');
            if (!principal.scopes.includes(spec.scope))
              throw new ApplicationError(403, 'MCP_SCOPE_REQUIRED');
            return messaging.runWithContext(
              {
                ...incoming,
                policies   : principal.policies,
                workspaces : principal.workspaces,
              },
              /** @returns {Promise<Object>} Contexto independiente y vigente. */ async () => {
                if (!spec.write || spec.journal) return entry.handler(message);
                const key = incoming.operation?.idempotencyKey;
                if (typeof key !== 'string' || key.length < 16 || key.length > 128)
                  throw new ApplicationError(400, 'IDEMPOTENCY_KEY_REQUIRED');
                const id = unitOfWork.hash([
                  principal.userCode,
                  principal.workspace,
                  incoming.delegation,
                  entry.name,
                  key,
                ]);
                const fingerprint = unitOfWork.hash(message.data),
                  policies        = unitOfWork.hash([...principal.policies].sort());
                /** @param {Object} receipt Resultado previo. @returns {Promise<Object>} Repite la respuesta bajo acceso vigente. */
                async function replay(receipt) {
                  if (receipt.fingerprint !== fingerprint)
                    throw new ApplicationError(409, 'IDEMPOTENCY_KEY_CONFLICT');
                  if (receipt.policies !== policies)
                    throw new ApplicationError(403, 'IDEMPOTENCY_PERMISSION_CHANGED');
                  if (receipt.entryId)
                    await documents.getOne({
                      entryId : receipt.entryId,
                      ...(receipt.trash ? { trash: true } : {}),
                    });
                  else if (receipt.repositoryId) await documents.authorizeReceipt(receipt);
                  return receipt.response;
                }
                const existing = await unitOfWork.receiptRead(id);
                if (existing) return replay(existing);
                try {
                  return await unitOfWork.run(
                    /** @returns {Promise<Object>} Recibo, estado y eventos en la misma transacción. */ async () => {
                      const committed = await unitOfWork.receiptRead(id);
                      if (committed) return replay(committed);
                      const raw    = await entry.handler(message);
                      const result = present ? present(entry.name, raw) : raw;
                      await unitOfWork.receiptInsert({
                        _id      : id,
                        fingerprint,
                        policies,
                        response : result,
                        ...(result.data?.id || message.data.entryId
                          ? {
                              entryId : result.data?.id || message.data.entryId,
                              trash   : entry.name === 'documents-entry-delete',
                            }
                          : {}),
                        ...(message.data.repositoryId
                          ? {
                              repositoryId : message.data.repositoryId,
                              action       :
                                entry.name === 'documents-file-upload-prepare' &&
                                message.data.overwrite
                                  ? 'update'
                                  : 'create',
                            }
                          : {}),
                      });
                      return result;
                    },
                  );
                } catch (error) {
                  const committed = await unitOfWork.receiptRead(id);
                  if (committed) return replay(committed);
                  throw error;
                }
              },
            );
          },
        };
      },
    );
}
module.exports = { documentDelegation };
