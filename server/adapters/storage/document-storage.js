/** @file Puerto de contenido documental; parámetros y resultados AWS permanecen aquí. */
'use strict';
/**
 * Ejecuta documentStorage dentro del flujo de document-storage.
 * @param {Object} options Colaboradores u opciones: storage, bucket.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function documentStorage({ storage, bucket }) {
  return Object.freeze({
    /**
     * Elimina el recurso indicado según las reglas del módulo.
     * @param {string} key Clave del campo o recurso que se procesa.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    delete : (key) =>
      storage.deleteObject({
        Bucket : bucket,
        Key    : key,
      }),
    /**
     * Ejecuta head dentro del flujo de document-storage.
     * @param {string} key Clave del campo o recurso que se procesa.
     * @returns {Promise<Object|null>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async head(key) {
      try {
        const result = await storage.headObject({
          Bucket : bucket,
          Key    : key,
        });
        return {
          size      : result.ContentLength,
          checksum  : result.Metadata?.checksum,
          operation : result.Metadata?.operation,
        };
      } catch (error) {
        if (
          error.$metadata?.httpStatusCode === 404 ||
          ['NotFound', 'NoSuchKey'].includes(error.name)
        )
          return null;
        throw error;
      }
    },
    /**
     * Ejecuta put dentro del flujo de document-storage.
     * @param {Object} options Colaboradores u opciones: key, content, mimeType, checksum, operation, signal.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    put    : ({ key, content, mimeType, checksum, operation, signal }) =>
      storage.putObject(
        {
          Bucket      : bucket,
          Key         : key,
          Body        : content,
          ContentType : mimeType,
          Metadata    : {
            checksum,
            operation,
          },
          IfNoneMatch : '*',
        },
        { abortSignal: signal },
      ),
    /**
     * Lee el contenido o registro solicitado.
     * @param {string} key Clave del campo o recurso que se procesa.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async read(key) {
      const result = await storage.getObject({
        Bucket : bucket,
        Key    : key,
      });
      if (result.Body?.transformToByteArray)
        return Buffer.from(await result.Body.transformToByteArray());
      if (result.Body?.[Symbol.asyncIterator]) {
        const chunks = [];
        for await (const chunk of result.Body) chunks.push(Buffer.from(chunk));
        return Buffer.concat(chunks);
      }
      return Buffer.from(result.Body);
    },
  });
}
module.exports = { documentStorage };
