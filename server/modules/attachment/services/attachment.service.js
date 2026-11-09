/** @file Almacén privado reutilizable de adjuntos de recursos: streaming, cuota transaccional e idempotencia. */
'use strict';
const { pipeline }         = require('node:stream/promises');
const { createHash }       = require('node:crypto');
const path                 = require('node:path');
const { ApplicationError } = require('../../../shared/application-error');
const { trustedScopes }    = require('../../settings/policies/settings.policy');
/**
 * Construye transferencias internas, aisladas de los archivos generales de Documents.
 * @param {Object} dependencies Almacenamiento, temporales, cuota y conexión MongoDB.
 * @returns {Object} Carga, descarga y liberación idempotentes.
 */
function attachmentService({
  storage,
  temporaryFiles,
  settingsRepository,
  repository,
  env,
  attachmentAudio,
  attachmentImage,
}) {
  /**
   * Obtiene la clave privada e inmutable del objeto desde sus metadatos normalizados.
   * @param {Object} record Metadatos del adjunto con su clave de almacenamiento.
   * @returns {*} Resultado de la operación; los errores se propagan al llamador.
   */
  const key    = (record) => record.storageKey;
  /**
   * Obtiene el depósito privado configurado para Documents.
   * @returns {*} Resultado de la operación; los errores se propagan al llamador.
   */
  const bucket = () => env.BUCKET_DOCUMENTS;
  /**
   * Verifica el origen interno y el identificador antes de acceder al almacén.
   * @param {*} data Datos públicos de la operación, validados por el caso de uso.
   * @param {*} originService Origen acreditado por el transporte de mensajería.
   * @returns {*} Resultado de la operación; los errores se propagan al llamador.
   */
  function authorize(data, originService) {
    if (!/^service-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(originService || ''))
      throw new ApplicationError(403, 'FORBIDDEN');
    if (
      typeof data.resourceType !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.resourceType) ||
      data.resourceType.length > 80 ||
      typeof data.resourceCode !== 'string' ||
      !data.resourceCode.trim() ||
      data.resourceCode.length > 100
    )
      throw new ApplicationError(400, 'INVALID_ATTACHMENT_RESOURCE');
    if (typeof data.attachmentCode !== 'string' || !/^[a-f0-9-]{36}$/.test(data.attachmentCode))
      throw new ApplicationError(400, 'INVALID_INPUT');
    if (!bucket()) throw new ApplicationError(503, 'ATTACHMENT_STORAGE_UNAVAILABLE');
  }
  /**
   * Impide que un servicio acceda a adjuntos vinculados a otro propietario o recurso.
   * @param {Object} record Metadatos normalizados por persistencia.
   * @param {Object} data Identidad pública del recurso solicitado.
   * @param {string} originService Origen acreditado por el transporte.
   * @returns {void} Finaliza si la pertenencia coincide.
   */
  function ownership(record, data, originService) {
    if (
      record.originService !== originService ||
      record.resourceType !== data.resourceType ||
      record.resourceCode !== data.resourceCode
    )
      throw new ApplicationError(403, 'ATTACHMENT_RESOURCE_MISMATCH');
  }
  /**
   * Calcula SHA-256 mediante streaming sin cargar el archivo completo en memoria.
   * @param {*} filename Ruta temporal confinada al directorio autorizado.
   * @returns {*} Resultado de la operación; los errores se propagan al llamador.
   */
  async function fingerprint(filename) {
    const hash = createHash('sha256');
    for await (const part of await temporaryFiles.readStream(filename)) hash.update(part);
    return hash.digest('hex');
  }
  /**
   * Reconoce imágenes por firma y acredita los contenedores de voz por sus pistas reales.
   * @param {*} filename Ruta temporal confinada al directorio autorizado.
   * @returns {*} Resultado de la operación; los errores se propagan al llamador.
   */
  async function mime(filename) {
    const handle = await temporaryFiles.promises.open(filename, 'r');
    try {
      const signature = Buffer.alloc(12);
      await handle.read(signature, 0, 12, 0);
      if (signature.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
      if (signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        return 'image/png';
      if (signature[0] === 255 && signature[1] === 216 && signature[2] === 255) return 'image/jpeg';
      if (
        signature.toString('ascii', 0, 4) === 'RIFF' &&
        signature.toString('ascii', 8, 12) === 'WEBP'
      )
        return 'image/webp';
      if (
        signature.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) ||
        signature.toString('ascii', 0, 4) === 'OggS' ||
        signature.toString('ascii', 4, 8) === 'ftyp'
      )
        return await attachmentAudio(filename);
      return 'application/octet-stream';
    } finally {
      await handle.close();
    }
  }
  return {
    /**
     * Consulta y concilia una carga incierta sin repetir escrituras ni reservas de cuota.
     * @param {Object} data Adjunto, recurso propietario y huella opcional de la carga original.
     * @param {string} originService Origen acreditado por la mensajería.
     * @returns {Promise<Object>} Estado privado y metadatos acreditados, nunca ubicación S3.
     */
    async status(data, originService) {
      authorize(data, originService);
      if (
        (data.digest !== undefined &&
          (typeof data.digest !== 'string' || !/^[a-f0-9]{64}$/.test(data.digest))) ||
        (data.size !== undefined &&
          (!Number.isSafeInteger(data.size) || data.size <= 0 || data.size > 200 * 1024 * 1024))
      )
        throw new ApplicationError(400, 'INVALID_INPUT');
      let record = await repository.findOne({ _id: data.attachmentCode });
      if (!record) return { state: 'missing' };
      ownership(record, data, originService);
      if (
        (data.digest !== undefined && record.digest !== data.digest) ||
        (data.size !== undefined && record.size !== data.size)
      )
        throw new ApplicationError(409, 'ATTACHMENT_REQUEST_CONFLICT');
      if (record.state === 'uploading') {
        let head;
        try {
          head = await storage.head({
            bucket : bucket(),
            key    : key(record),
          });
        } catch (error) {
          throw new ApplicationError(503, 'STORAGE_READ_UNCERTAIN', {
            cause : error,
          });
        }
        if (head) {
          if (
            head.size !== record.size ||
            head.metadata?.sha256 !== record.digest ||
            head.mimeType !== record.mime
          )
            throw new ApplicationError(409, 'ATTACHMENT_REQUEST_CONFLICT');
          await repository.updateOne(
            {
              _id   : data.attachmentCode,
              state : 'uploading',
            },
            { $set: { state: 'ready' } },
          );
          // El borrado concurrente gana: nunca resucitar un adjunto ni liberar cuota aquí.
          record = await repository.findOne({ _id: data.attachmentCode });
          if (!record) return { state: 'missing' };
          ownership(record, data, originService);
        }
      }
      return {
        state : record.state,
        ...(record.state === 'ready'
          ? {
              mime   : record.mime,
              size   : record.size,
              digest : record.digest,
            }
          : {}),
      };
    },
    /**
     * Retira un temporal de descarga cuando el dominio propietario revoca el acceso durante la transferencia.
     * @param {Object} data Código de adjunto y ruta devuelta por download.
     * @param {string} originService Origen acreditado por la mensajería.
     * @returns {Promise<Object>} Confirmación de retirada; no modifica el objeto ni su cuota.
     */
    async discard(data, originService) {
      authorize(data, originService);
      const record = await repository.findOne({ _id: data.attachmentCode });
      if (!record) return {};
      ownership(record, data, originService);
      if (
        typeof data.tempFilePath !== 'string' ||
        !new RegExp(`^[a-f0-9-]{36}-attachment-${data.attachmentCode}-(?:download|preview)$`).test(
          path.basename(data.tempFilePath),
        )
      )
        throw new ApplicationError(400, 'INVALID_INPUT');
      await temporaryFiles.remove(await temporaryFiles.validate(data.tempFilePath));
      return {};
    },
    /**
     * Carga un adjunto privado conservando identidad, tamaño e idempotencia.
     * @param {*} data Datos públicos de la operación, validados por el caso de uso.
     * @param {*} originService Origen acreditado por el transporte de mensajería.
     * @returns {*} Resultado de la operación; los errores se propagan al llamador.
     */
    async upload(data, originService) {
      authorize(data, originService);
      const filename = await temporaryFiles.validate(data.tempFilePath);
      try {
        const stats = await temporaryFiles.promises.stat(filename);
        if (
          !stats.isFile() ||
          stats.size !== data.size ||
          stats.size <= 0 ||
          stats.size > 200 * 1024 * 1024
        )
          throw new ApplicationError(413, 'ATTACHMENT_TOO_LARGE');
        const digest  = await fingerprint(filename),
          contentType = await mime(filename);
        let record = await repository.findOne({ _id: data.attachmentCode });
        if (record) ownership(record, data, originService);
        if (
          record &&
          (record.digest !== digest ||
            record.size !== stats.size ||
            record.resourceCode !== data.resourceCode)
        )
          throw new ApplicationError(409, 'ATTACHMENT_REQUEST_CONFLICT');
        if (record?.state === 'deleted' || record?.state === 'deleting')
          throw new ApplicationError(409, 'ATTACHMENT_UNAVAILABLE');
        if (record?.state === 'ready') return { mime: record.mime };
        if (!record) {
          await repository.transaction(
            /**
             * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
             * @param {Object} session Sesión que agrupa las operaciones de persistencia.
             * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
             */
            async (session) => {
              await repository.insertOne(
                {
                  _id          : data.attachmentCode,
                  originService,
                  resourceType : data.resourceType,
                  resourceCode : data.resourceCode,
                  storageKey   : `private/attachments/${originService}/${data.attachmentCode}`,
                  digest,
                  size         : stats.size,
                  mime         : contentType,
                  state        : 'uploading',
                  creationDate : Date.now(),
                },
                { session },
              );
              await settingsRepository.adjustUsedSpace(stats.size, trustedScopes.guest, {
                reserve  : true,
                fileSize : stats.size,
                session,
              });
            },
          );
          record = {
            storageKey : `private/attachments/${originService}/${data.attachmentCode}`,
            digest,
            size       : stats.size,
            mime       : contentType,
          };
        }
        // La clave es inmutable: un reintento sólo acepta exactamente los mismos bytes.
        try {
          await storage.put({
            bucket       : bucket(),
            key          : key(record),
            content      : await temporaryFiles.readStream(filename),
            size         : stats.size,
            mimeType     : contentType,
            encrypt      : true,
            onlyIfAbsent : true,
            metadata     : { sha256: digest },
          });
        } catch (error) {
          const head = await storage
            .head({
              bucket : bucket(),
              key    : key(record),
            })
            .catch(
              /**
               * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
               * @returns {null} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
               */
              () => null,
            );
          if (!head || head.size !== stats.size || head.metadata?.sha256 !== digest)
            throw new ApplicationError(503, 'STORAGE_WRITE_UNCERTAIN', {
              uncertain : true,
              cause     : error,
            });
        }
        const saved = await repository.updateOne(
          {
            _id   : data.attachmentCode,
            state : 'uploading',
          },
          { $set: { state: 'ready' } },
        );
        if (!saved.matchedCount) {
          const current = await repository.findOne({
            _id : data.attachmentCode,
          });
          if (current?.state !== 'ready') throw new ApplicationError(409, 'ATTACHMENT_UNAVAILABLE');
        }
        return { mime: record.mime };
      } finally {
        await temporaryFiles.remove(filename);
      }
    },
    /**
     * Obtiene un temporal de descarga después de comprobar acceso vigente.
     * @param {*} data Datos públicos de la operación, validados por el caso de uso.
     * @param {*} originService Origen acreditado por el transporte de mensajería.
     * @returns {*} Resultado de la operación; los errores se propagan al llamador.
     */
    async download(data, originService) {
      authorize(data, originService);
      const record = await repository.findOne({
        _id   : data.attachmentCode,
        state : 'ready',
      });
      if (!record) throw new ApplicationError(404, 'ATTACHMENT_UNAVAILABLE');
      ownership(record, data, originService);
      const filename = temporaryFiles.uniquePath(`attachment-${data.attachmentCode}-download`);
      try {
        await temporaryFiles.validate(filename);
        const result = await storage.read({
          bucket : bucket(),
          key    : key(record),
        });
        await pipeline(
          result.content,
          await temporaryFiles.writeStream(filename, {
            flags : 'wx',
            mode  : 0o600,
          }),
        );
        if ((await temporaryFiles.promises.stat(filename)).size !== record.size)
          throw new Error('Invalid storage length');
        return { tempFilePath: filename };
      } catch (error) {
        await temporaryFiles.remove(filename);
        throw error;
      }
    },
    /** Genera una miniatura temporal sin modificar el original, su cuota ni el catálogo de archivos.
     * @param {Object} data Código de adjunto confirmado por su dominio propietario.
     * @param {string} originService Servicio acreditado por el transporte interno.
     * @returns {Promise<Object>} Temporal WebP y dimensiones; rechaza archivos no previsualizables.
     */
    async preview(data, originService) {
      authorize(data, originService);
      const record = await repository.findOne({
        _id   : data.attachmentCode,
        state : 'ready',
      });
      if (!record) throw new ApplicationError(404, 'ATTACHMENT_UNAVAILABLE');
      ownership(record, data, originService);
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(record.mime))
        throw new ApplicationError(415, 'ATTACHMENT_PREVIEW_UNAVAILABLE');
      if (record.size > 20 * 1024 * 1024)
        throw new ApplicationError(413, 'ATTACHMENT_PREVIEW_UNAVAILABLE');
      const destination = await temporaryFiles.validate(
        temporaryFiles.uniquePath(`attachment-${data.attachmentCode}-preview`),
      );
      const original    = await this.download(data, originService);
      try {
        const dimensions = await attachmentImage(original.tempFilePath, destination);
        const current    = await repository.findOne({
          _id   : data.attachmentCode,
          state : 'ready',
        });
        if (!current || current.digest !== record.digest)
          throw new ApplicationError(404, 'ATTACHMENT_UNAVAILABLE');
        return {
          tempFilePath : destination,
          mime         : 'image/webp',
          ...dimensions,
        };
      } catch (error) {
        await temporaryFiles.remove(destination);
        throw error;
      } finally {
        await temporaryFiles.remove(original.tempFilePath);
      }
    },
    /**
     * Elimina un objeto privado y libera su cuota una sola vez.
     * @param {*} data Datos públicos de la operación, validados por el caso de uso.
     * @param {*} originService Origen acreditado por el transporte de mensajería.
     * @returns {*} Resultado de la operación; los errores se propagan al llamador.
     */
    async delete(data, originService) {
      authorize(data, originService);
      const current = await repository.findOne({ _id: data.attachmentCode });
      if (!current) return {};
      ownership(current, data, originService);
      const record = await repository.findOneAndUpdate(
        {
          _id   : data.attachmentCode,
          state : { $in: ['ready', 'uploading', 'deleting'] },
        },
        { $set: { state: 'deleting' } },
        { returnDocument: 'after' },
      );
      if (!record) return {};
      await storage.delete({
        bucket : bucket(),
        key    : key(record),
      });
      await repository.transaction(
        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @param {Object} session Sesión que agrupa las operaciones de persistencia.
         * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
         */
        async (session) => {
          const updated = await repository.updateOne(
            {
              _id   : data.attachmentCode,
              state : 'deleting',
            },
            {
              $set : {
                state        : 'deleted',
                deletionDate : Date.now(),
              },
            },
            { session },
          );
          if (updated.modifiedCount)
            await settingsRepository.adjustUsedSpace(-record.size, trustedScopes.guest, {
              session,
            });
        },
      );
      return {};
    },
  };
}
module.exports = attachmentService;
