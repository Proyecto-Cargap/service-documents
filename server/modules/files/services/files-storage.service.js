/** @file Almacenamiento de Files invocado por dominios: variantes, cuota e identidad estable. */
'use strict';
const { pipeline }         = require('node:stream/promises');
const { createHash }       = require('node:crypto');
const { ApplicationError } = require('../../../shared/application-error');
const { trustedScopes }    = require('../../settings/policies/settings.policy');
const SIZES                = Object.freeze(['050', '100', '200', '300', '500', '1000']);
const ID                   = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/**
 * Compone el almacenamiento técnico sin políticas de usuario de Files.
 * @param {Object} dependencies Adaptadores de MongoDB, S3, imágenes, temporales y contexto.
 * @returns {Object} Operaciones internas y lectura pública explícita.
 */
module.exports = function filesStorageService({
  repository,
  storage,
  temporaryFiles,
  settingsRepository,
  imageProcessor,
  messaging,
  env,
  logger = {
    /**
     * Ofrece el punto de extensión error sin efectos por defecto.
     * @returns {void} Finaliza después de aplicar los efectos de la operación.
     */
    error() {},
  },
}) {
  let recovering;
  /**
   * Ejecuta bucket dentro del flujo de files-storage.service.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  const bucket = () => env.BUCKET || env.BUCKET_DOCUMENTS;
  /** Valida un identificador técnico, sin admitir rutas suministradas por el cliente.
   * @param {Object} data Datos de entrada de la operación.
   * @returns {void} Finaliza después de aplicar los efectos de la operación.
   */
  function identity(data) {
    if (!data || typeof data.fileId !== 'string' || !ID.test(data.fileId))
      throw new ApplicationError(400, 'INVALID_FILE_ID');
    if (!bucket()) throw new ApplicationError(503, 'FILE_STORAGE_UNAVAILABLE');
  }
  /** Verifica al dominio acreditado por mensajería, nunca por campos del cuerpo HTTP.
   * @param {Object} data Datos de entrada de la operación.
   * @param {*} originService Valor de originService utilizado por esta operación.
   * @param {*} record Valor de record utilizado por esta operación.
   * @returns {void} Finaliza después de aplicar los efectos de la operación.
   */
  function domain(data, originService, record) {
    identity(data);
    if (!/^service-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(originService || ''))
      throw new ApplicationError(403, 'FILE_DOMAIN_REQUIRED');
    if (
      typeof data.resourceType !== 'string' ||
      !data.resourceType ||
      typeof data.resourceCode !== 'string' ||
      !data.resourceCode
    )
      throw new ApplicationError(400, 'INVALID_FILE_RESOURCE');
    if (
      record &&
      (record.originService !== originService ||
        record.resourceType !== data.resourceType ||
        record.resourceCode !== data.resourceCode)
    )
      throw new ApplicationError(403, 'FILE_DOMAIN_MISMATCH');
  }
  /** Calcula la identidad de los bytes mediante streaming.
   * @param {string} filename Ruta del archivo que se procesa.
   * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  async function digest(filename) {
    const hash = createHash('sha256');
    for await (const part of await temporaryFiles.readStream(filename)) hash.update(part);
    return hash.digest('hex');
  }
  /** Devuelve sólo metadatos de cliente; las claves del almacén permanecen internas.
   * @param {*} record Valor de record utilizado por esta operación.
   * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  function reference(record) {
    return {
      id         : record.storageId,
      name       : record.fileNameReal,
      size       : record.size,
      mimeType   : record.mimeType,
      visibility : record.scope,
      sizes      : record.variants.map(
        /**
         * Proyecta cada elemento en la estructura requerida por la operación.
         * @param {*} variant Valor de variant utilizado por esta operación.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        (variant) => variant.label,
      ),
      url        : record.scope === 'public' ? `/files/public/v1/${record.storageId}` : '',
    };
  }
  /** Descarga una versión registrada a un temporal confinado.
   * @param {*} record Valor de record utilizado por esta operación.
   * @param {*} [requestedSize] Valor de requestedSize utilizado por esta operación.
   * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  async function transfer(record, requestedSize = 'original') {
    if (!['original', ...SIZES].includes(requestedSize))
      throw new ApplicationError(400, 'INVALID_IMAGE_SIZE');
    if (record.storageState !== 'ready') throw new ApplicationError(409, 'FILE_NOT_READY');
    const size    = record.thumbnail ? requestedSize : 'original';
    const variant = record.variants.find(
      /**
       * Determina si el elemento corresponde al recurso buscado.
       * @param {*} item Valor de item utilizado por esta operación.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (item) => item.label === size,
    );
    if (!variant) throw new ApplicationError(404, 'FILE_VARIANT_NOT_FOUND');
    const filename = temporaryFiles.uniquePath('files-download');
    try {
      const object = await storage.read({
        bucket : bucket(),
        key    : variant.key,
      });
      await pipeline(
        object.content,
        await temporaryFiles.writeStream(await temporaryFiles.validate(filename), {
          flags : 'wx',
          mode  : 0o600,
        }),
      );
      return {
        tempFilePath : filename,
        fileName     : record.fileNameReal,
        mimeType     : variant.mimeType,
        size         : variant.label,
      };
    } catch (error) {
      await temporaryFiles.remove(filename).catch(
        /**
         * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
         * @returns {void} Finaliza después de aplicar los efectos de la operación.
         */
        () => {},
      );
      throw new ApplicationError(503, 'FILE_READ_FAILED', { cause: error });
    }
  }
  const service = {
    /**
     * Prepara el índice técnico y recupera eliminaciones previamente acreditadas.
     * @returns {Promise<void>} Almacenamiento listo para consumir mensajes.
     */
    async start() {
      await repository.verifyIndex();
    },
    /**
     * Detiene la recuperación sin interrumpir una liberación de cuota en curso.
     * @returns {Promise<void>} Recuperación detenida.
     */
    async close() {
      if (recovering) await recovering;
    },
    /**
     * Reintenta sólo eliminaciones ya iniciadas por el dominio propietario.
     * @param {Object} options Continuidad y cierre cooperativo.
     * @returns {Promise<void>} Ciclo de recuperación finalizado.
     */
    async recover(options = {}) {
      if (recovering) return recovering;
      recovering = (
        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
         */
        async () => {
          for (const record of await repository.pendingDeletes()) {
            if (options.shouldStop?.()) break;
            await service
              .remove(
                {
                  fileId       : record.storageId,
                  resourceType : record.resourceType,
                  resourceCode : record.resourceCode,
                },
                record.originService,
              )
              .catch(
                /**
                 * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
                 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                 */
                () =>
                  logger.error({
                    component : 'files_storage',
                    event     : 'cleanup_pending',
                    code      : 'FILE_CLEANUP_PENDING',
                  }),
              );
          }
        }
      )().finally(
        /**
         * Libera o restablece los recursos al terminar la operación.
         * @returns {void} Finaliza después de aplicar los efectos de la operación.
         */
        () => {
          recovering = undefined;
        },
      );
      return recovering;
    },
    /**
     * Guarda bytes intactos y, opcionalmente, versiones PNG de una imagen validada.
     * @param {Object} data Archivo, identidad de recurso y opciones del dominio.
     * @param {string} originService Servicio invocador acreditado por mensajería.
     * @returns {Promise<Object>} Referencia estable con tamaños disponibles.
     */
    async upload(data, originService) {
      domain(data, originService);
      const filename = await temporaryFiles.validate(data.tempFilePath);
      try {
        if (
          !['public', 'private'].includes(data.visibility) ||
          typeof data.generateVariants !== 'boolean'
        )
          throw new ApplicationError(400, 'INVALID_FILE_OPTIONS');
        if (typeof data.name !== 'string' || !data.name || /[\r\n\0]/.test(data.name))
          throw new ApplicationError(400, 'INVALID_FILE_NAME');
        const stat = await temporaryFiles.promises.stat(filename);
        if (!stat.isFile() || stat.size <= 0 || stat.size > 200 * 1024 * 1024)
          throw new ApplicationError(413, 'FILE_TOO_LARGE');
        const fingerprint = await digest(filename);
        let record        = await repository.get(data.fileId);
        if (record) {
          domain(data, originService, record);
          if (
            record.digest !== fingerprint ||
            record.scope !== data.visibility ||
            record.thumbnail !== data.generateVariants
          )
            throw new ApplicationError(409, 'FILE_REQUEST_CONFLICT');
          if (record.storageState === 'ready') return reference(record);
          if (record.storageState !== 'uploading')
            throw new ApplicationError(409, 'FILE_NOT_READY');
        }
        const key    = `${data.visibility}/files/v1/${data.fileId}`;
        let metadata = null;
        if (data.image === true || data.generateVariants) {
          if (stat.size > 20 * 1024 * 1024) throw new ApplicationError(413, 'IMAGE_TOO_LARGE');
          try {
            metadata = await imageProcessor.metadata(filename);
          } catch {
            throw new ApplicationError(400, 'INVALID_IMAGE');
          }
          if (!['png', 'jpeg', 'webp'].includes(metadata.format))
            throw new ApplicationError(400, 'INVALID_IMAGE');
        }
        const mimeType = metadata ? `image/${metadata.format}` : 'application/octet-stream';
        const variants = [
          {
            label  : 'original',
            key    : `${key}/original`,
            size   : stat.size,
            width  : metadata?.width || 0,
            height : metadata?.height || 0,
            mimeType,
          },
        ];
        const images   = [];
        if (data.generateVariants) {
          for (const label of SIZES) {
            const { data: buffer, info } = await imageProcessor.variantPng(filename, Number(label));
            variants.push({
              label,
              key      : `${key}/${label}`,
              size     : buffer.length,
              width    : info.width,
              height   : info.height,
              mimeType : 'image/png',
            });
            images.push(buffer);
          }
        }
        const totalSize = variants.reduce(
          /**
           * Acumula el resultado de los elementos recorridos.
           * @param {*} sum Valor de sum utilizado por esta operación.
           * @param {*} item Valor de item utilizado por esta operación.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          (sum, item) => sum + item.size,
          0,
        );
        if (!record) {
          const context = messaging.getContext();
          record = {
            storageId    : data.fileId,
            originService,
            resourceType : data.resourceType,
            resourceCode : data.resourceCode,
            storageState : 'uploading',
            digest       : fingerprint,
            fileName     : data.fileId,
            fileNameReal : data.name,
            path         : variants[0].key,
            module       : originService.replace('service-', ''),
            scope        : data.visibility,
            size         : stat.size,
            totalSize,
            variants,
            mimeType,
            thumbnail    : data.generateVariants,
            private      : data.visibility === 'private',
            workspace    : data.workspace || context.workspace,
            userCreate   : context.user?.userCode || '',
            userAssigned : '',
          };
          await repository.transaction(
            /**
             * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
             * @param {Object} session Sesión que agrupa las operaciones de persistencia.
             * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
             */
            async (session) => {
              await repository.insert(record, session);
              await settingsRepository.adjustUsedSpace(totalSize, trustedScopes.guest, {
                reserve  : true,
                fileSize : stat.size,
                session,
              });
            },
          );
        }
        try {
          await storage.put({
            bucket   : bucket(),
            key      : variants[0].key,
            content  : await temporaryFiles.readStream(filename),
            mimeType : mimeType,
          });
          for (let index = 0; index < images.length; index++)
            await storage.put({
              bucket   : bucket(),
              key      : variants[index + 1].key,
              content  : images[index],
              mimeType : 'image/png',
            });
          record =
            (await repository.transition(data.fileId, ['uploading'], 'ready')) ||
            (await repository.get(data.fileId));
          if (record.storageState !== 'ready') {
            for (const variant of variants)
              await storage.delete({
                bucket : bucket(),
                key    : variant.key,
              });
            throw new ApplicationError(409, 'FILE_UPLOAD_CANCELLED');
          }
          return reference(record);
        } catch (error) {
          throw new ApplicationError(503, 'STORAGE_WRITE_UNCERTAIN', {
            uncertain : true,
            cause     : error,
          });
        }
      } finally {
        await temporaryFiles.remove(filename).catch(
          /**
           * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
           * @returns {void} Finaliza después de aplicar los efectos de la operación.
           */
          () => {},
        );
      }
    },
    /**
     * Lee el contenido después de la autorización del dominio propietario.
     * @param {Object} data Identificador, recurso y tamaño solicitado.
     * @param {string} originService Origen acreditado por mensajería.
     * @returns {Promise<Object>} Temporal confinado y metadatos de transferencia.
     */
    async read(data, originService) {
      domain(data, originService);
      const record = await repository.get(data.fileId);
      if (!record) throw new ApplicationError(404, 'FILE_NOT_FOUND');
      domain(data, originService, record);
      return transfer(record, data.size);
    },
    /**
     * Permite únicamente la lectura de un archivo explícitamente público y listo.
     * @param {Object} data Identificador y tamaño solicitado.
     * @returns {Promise<Object>} Temporal confinado y metadatos de transferencia.
     */
    async readPublic(data) {
      identity(data);
      const record = await repository.get(data.fileId);
      if (!record || record.scope !== 'public' || record.private)
        throw new ApplicationError(404, 'FILE_NOT_FOUND');
      return transfer(record, data.size);
    },
    /**
     * Elimina todas las versiones y libera su cuota exactamente una vez.
     * @param {Object} data Identificador y recurso acreditados por el dominio.
     * @param {string} originService Origen de mensajería verificado.
     * @returns {Promise<Object>} Confirmación idempotente.
     */
    async remove(data, originService) {
      domain(data, originService);
      let record = await repository.get(data.fileId);
      if (!record) return {};
      domain(data, originService, record);
      if (record.storageState === 'deleted') return {};
      record =
        (await repository.transition(data.fileId, ['uploading', 'ready'], 'deleting')) ||
        (await repository.get(data.fileId));
      if (record.storageState === 'deleted') return {};
      record = await repository.claimDelete(data.fileId);
      if (!record) throw new ApplicationError(503, 'FILE_CLEANUP_PENDING');
      const owner      = record.cleanupOwner;
      const controller = new AbortController();
      const timer      = setTimeout(
        /** @returns {void} Limita el efecto externo por debajo del lease; no consulta datos. */
        () => controller.abort(),
        310000,
      );
      timer.unref?.();
      try {
        for (const variant of record.variants) {
          controller.signal.throwIfAborted();
          await storage.delete({
            bucket : bucket(),
            key    : variant.key,
            signal : controller.signal,
          });
        }
        await repository.transaction(
          /** @param {Object} session Unidad atómica. @returns {Promise<void>} Confirma estado y cuota una sola vez y sólo bajo el lease vigente. */
          async (session) => {
            record = await repository.get(data.fileId, session);
            if (record.storageState === 'deleted') return;
            if (record.cleanupOwner !== owner || record.cleanupUntil <= Date.now())
              throw new ApplicationError(503, 'FILE_CLEANUP_LEASE_LOST');
            await settingsRepository.adjustUsedSpace(-record.totalSize, trustedScopes.guest, {
              session,
            });
            await repository.update(
              data.fileId,
              {
                storageState : 'deleted',
                erased       : true,
                cleanupOwner : '',
                cleanupUntil : 0,
              },
              session,
            );
          },
        );
      } catch (error) {
        await repository.retryDelete(data.fileId, owner);
        throw error;
      } finally {
        clearTimeout(timer);
      }
      return {};
    },
  };
  return service;
};
