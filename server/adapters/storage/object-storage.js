/** @file Contrato de contenido para Files y adjuntos; encapsula parámetros y errores S3. */
'use strict';
/**
 * Adapta un almacén S3 al contrato de contenido del dominio; conserva streaming, metadatos, cifrado y escrituras condicionales.
 * @param {Object} options Colaboradores u opciones: storage.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function objectStorage({ storage }) {
  return Object.freeze({
    /**
     * Ejecuta put dentro del flujo de object-storage.
     * @param {Object} options Colaboradores u opciones: bucket, key, content, mimeType, size, metadata, onlyIfAbsent, encrypt.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    put    : ({ bucket, key, content, mimeType, size, metadata, onlyIfAbsent, encrypt }) =>
      storage.putObject({
        Bucket : bucket,
        Key    : key,
        Body   : content,
        ...(mimeType === undefined ? {} : { ContentType: mimeType }),
        ...(size === undefined ? {} : { ContentLength: size }),
        ...(metadata === undefined ? {} : { Metadata: metadata }),
        ...(onlyIfAbsent ? { IfNoneMatch: '*' } : {}),
        ...(encrypt ? { ServerSideEncryption: 'AES256' } : {}),
      }),
    /**
     * Lee el contenido o registro solicitado.
     * @param {Object} options Colaboradores u opciones: bucket, key.
     * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async read({ bucket, key }) {
      const result = await storage.getObject({
        Bucket : bucket,
        Key    : key,
      });
      return {
        content  : result.Body,
        size     : result.ContentLength,
        mimeType : result.ContentType,
        metadata : result.Metadata,
      };
    },
    /**
     * Ejecuta head dentro del flujo de object-storage.
     * @param {Object} options Colaboradores u opciones: bucket, key.
     * @returns {Promise<Object|null>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async head({ bucket, key }) {
      try {
        const result = await storage.headObject({
          Bucket : bucket,
          Key    : key,
        });
        return {
          size     : result.ContentLength,
          mimeType : result.ContentType,
          metadata : result.Metadata,
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
     * Elimina el recurso indicado según las reglas del módulo.
     * @param {Object} options Colaboradores u opciones: bucket, key.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    delete : ({ bucket, key, signal }) =>
      storage.deleteObject(
        {
          Bucket : bucket,
          Key    : key,
        },
        signal ? { abortSignal: signal } : undefined,
      ),
  });
}
module.exports = { objectStorage };
