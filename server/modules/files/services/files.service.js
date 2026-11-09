/**
 * @file Operaciones de aplicación de archivos. Coordina las validaciones y las colaboraciones necesarias
 * para cada solicitud.
 */

'use strict';

const { ApplicationError }                = require('../../../shared/application-error');
const settingsPolicy                      = require('../../settings/policies/settings.policy');
const { endpointOrigin, fileResourceUrl } = require('../../../shared/endpoint-origin');
/**
 * Compone el servicio de archivos con almacenamiento y persistencia autorizada.
 * Cada instancia inicia accessScope vacío y el documento de trabajo en null.
 *
 * @param {Object} dependencies Adaptadores y configuración usados por esta capacidad.
 * @param {Object} dependencies.logger Logger técnico para fallos de almacenamiento o renderizado.
 * @param {Object} dependencies.storage Adaptador de lectura, escritura, copia, listado y
 * eliminación de objetos S3.
 * @param {Object} dependencies.messaging Contexto de ejecución y cliente de solicitudes/comandos
 * entre servicios.
 * @param {Object} dependencies.settingsRepository Lectura y actualización de parámetros técnicos de
 * archivos y QR.
 * @param {Object} dependencies.identity Identidad del servicio usada en los códigos públicos de
 * error.
 * @param {string} dependencies.identity.id Prefijo de los códigos de error de esta instalación.
 * @param {Object} dependencies.temporaryFiles Rutas temporales únicas, validación de confinamiento
 * y operaciones de archivos.
 * @param {Object} dependencies.imageProcessor Puerto de metadatos y generación de miniaturas.
 * @param {Object} dependencies.filesRepository Persistencia de metadatos de archivos con
 * autorización local.
 * @param {Function} dependencies.newFileId Genera un identificador hexadecimal para metadatos nuevos.
 * @param {Object} dependencies.env Configuración de buckets, directorio temporal y enlaces de
 * descarga usada por el módulo.
 * @returns {Function} Constructor FilesService; el controller crea una instancia por mensaje.
 */
module.exports = function filesService(dependencies) {
  const publicOrigin       = endpointOrigin(dependencies.env.END_POINT);
  const policy             = require('../policies/files.policy');
  const logger             = dependencies.logger;
  const storage            = dependencies.storage;
  const messaging          = dependencies.messaging;
  const settingsRepository = dependencies.settingsRepository;
  const { id }             = dependencies.identity;
  const fs                 = dependencies.temporaryFiles;
  const images             = dependencies.imageProcessor;
  const filesRepository    = dependencies.filesRepository;
  const controller         = 'C005';
  const ALLOWED_EXTENSIONS = [
    'aac',
    'amr',
    'm4a',
    'ogg',
    'pem',
    'mp4',
    'mov',
    'ico',
    'cer',
    'gif',
    'key',
    'jpg',
    'jpeg',
    'png',
    'bpm',
    'csv',
    'mp3',
    'zip',
    'pdf',
    'xls',
    'xlsx',
    'doc',
    'docx',
    'ppt',
    'pptx',
    'txt',
    'xml',
  ];
  const awsS3Url           = 'https://s3.amazonaws.com';
  return class FilesService {
    #accessScope = '';

    #document = null;
    /**
     * Carga el archivo en S3 y prepara sus metadatos, enlace y recursos derivados.
     * Confirma el consumo y su hecho de configuración para el canal realtime estándar.
     *
     * @param {Object} data Datos de archivos que utiliza module, userCode, fileName, tempFilePath, scope,
     * thumbnail, cleanTemp.
     * @returns {Promise<*>|null} Datos de la operación; los errores se propagan como ApplicationError.
     */
    async create(data) {
      this.#accessScope = data.accessScope === undefined ? '' : data.accessScope;

      let effectStarted    = false;
      const temporaryPaths = new Set();
      try {
        if (data.tempFilePath) await fs.validate(data.tempFilePath);
        const system = messaging.getContext();
        if (data.module == undefined || data.module == '') {
          throw new ApplicationError(400, `${id}-${controller}-E0010:module is required`);
        }
        if (data.userCode == undefined || data.userCode == '') {
          throw new ApplicationError(400, `${id}-${controller}-E0020:userCode is required`);
        }
        if (data.fileName == undefined || data.fileName == '') {
          throw new ApplicationError(400, `${id}-${controller}-E0030:fileName is required`);
        }
        if (data.tempFilePath == undefined || data.tempFilePath == '') {
          throw new ApplicationError(400, `${id}-${controller}-E0040:tempFilePath is required`);
        }
        if (!['public', 'private'].includes(data.scope)) {
          throw new ApplicationError(400, `${id}-${controller}-E0050:scope is required`);
        }
        const fileNameUploadedSplit = data.fileName.split('.');
        const extension             = fileNameUploadedSplit[fileNameUploadedSplit.length - 1];
        if (ALLOWED_EXTENSIONS.indexOf(extension.toLowerCase()) < 0) {
          throw new ApplicationError(400, `${id}-${controller}-E0060:Extensions not allowed`);
        }
        const stats    = await fs.promises.stat(data.tempFilePath);
        const size     = stats.size;
        const newId    = dependencies.newFileId();
        const path     = `${data.scope}/${data.module}`;
        const fileName = `${newId}-${new Date().getMilliseconds()}`;
        const rawLink  = `${awsS3Url}/${dependencies.env.BUCKET}/${path}/${fileName}.${extension}`;
        const body     = {
          _id           : newId,
          module        : data.module,
          fileName      : `${fileName}.${extension}`,
          path          : `${path}/${fileName}.${extension}`,
          rawLink       : rawLink,
          type          : 'file',
          fileNameReal  : data.fileName,
          userCreate    : system.user?.userCode || '',
          workspace     : data.workspace === undefined ? system.workspace : data.workspace,
          userAssigned  : data.userAssigned === undefined ? '' : data.userAssigned,
          scope         : data.scope,
          thumbnail     : data.thumbnail != undefined ? data.thumbnail : false,
          idTransaction : system.idTransaction,
          size,
          extension,
        };
        if (!policy.authorize('create', body, this.#accessScope, system))
          throw new ApplicationError(403, 'FILE_ACCESS_DENIED');
        this.#document = await filesRepository.create(body, this.#accessScope);
        let sizeThumbnail = 0;
        if (this.#document.thumbnail) {
          const outputFile050  = `${dependencies.env.TEMP}/${fileName}.${extension}@050`;
          const outputFile100  = `${dependencies.env.TEMP}/${fileName}.${extension}@100`;
          const outputFile200  = `${dependencies.env.TEMP}/${fileName}.${extension}@200`;
          const outputFile300  = `${dependencies.env.TEMP}/${fileName}.${extension}@300`;
          const outputFile500  = `${dependencies.env.TEMP}/${fileName}.${extension}@500`;
          const outputFile1000 = `${dependencies.env.TEMP}/${fileName}.${extension}@1000`;
          const sizes          = [
            {
              width     : 50,
              output    : outputFile050,
              keySuffix : '@050',
            },
            {
              width     : 100,
              output    : outputFile100,
              keySuffix : '@100',
            },
            {
              width     : 200,
              output    : outputFile200,
              keySuffix : '@200',
            },
            {
              width     : 300,
              output    : outputFile300,
              keySuffix : '@300',
            },
            {
              width     : 500,
              output    : outputFile500,
              keySuffix : '@500',
            },
            {
              width     : 1000,
              output    : outputFile1000,
              keySuffix : '@1000',
            },
          ];
          for (const size of sizes) {
            temporaryPaths.add(size.output);
            await images.resizeFile(data.tempFilePath, size.width, await fs.validate(size.output));
            effectStarted = true;
            await storage.put({
              content : await fs.promises.readFile(size.output),
              bucket  : `${dependencies.env.BUCKET}`,
              key     : `${this.#document.path}${size.keySuffix}`,
            });
            sizeThumbnail += (await fs.promises.stat(size.output)).size;
            await fs.promises.unlink(size.output);
          }
        }
        const contentInput = {
          content : await fs.promises.readFile(data.tempFilePath),
          bucket  : `${dependencies.env.BUCKET}`,
          key     : `${path}/${fileName}.${extension}`,
        };
        try {
          effectStarted = true;
          await storage.put(contentInput);
          await settingsRepository.adjustUsedSpace(
            +size + sizeThumbnail,
            settingsPolicy.trustedScopes.guest,
          );
          const urlResource = fileResourceUrl(
            publicOrigin,
            data.scope,
            `${fileName}.${extension.toLowerCase()}`,
          );
          if (
            data.cleanTemp === undefined ||
            (data.cleanTemp !== undefined && data.cleanTemp === true)
          ) {
            await fs.promises.unlink(data.tempFilePath);
          }
          return {
            urlResource : urlResource,
            rawLink     : rawLink,
            error       : false,
            code        : 201,
            description : 'ok',
          };
        } catch (err) {
          if (err instanceof ApplicationError) throw err;
          throw new ApplicationError(
            500,
            `${id}-${controller}-E0090:Error trying to upload file to AWS S3`,
          );
        }
      } catch (err) {
        if (effectStarted)
          throw new ApplicationError(500, 'STORAGE_WRITE_UNCERTAIN', {
            uncertain : true,
            cause     : err,
          });
        if (err instanceof ApplicationError) throw err;
        logger.error({
          event     : 'operation_failed',
          component : 'storage',
          code      : 'OPERATION_FAILED',
        });
        throw new ApplicationError(500, `${id}-${controller}-E0000:Error system`);
      } finally {
        if (data?.cleanTemp !== false)
          await fs.remove(data?.tempFilePath).catch(
            /**
             * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
             * @returns {void} Finaliza después de aplicar los efectos de la operación.
             */
            () => {},
          );
        for (const filename of temporaryPaths)
          await fs.remove(filename).catch(
            /**
             * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
             * @returns {void} Finaliza después de aplicar los efectos de la operación.
             */
            () => {},
          );
      }
    }

    /**
     * Obtiene un registro de archivos y prepara los datos utilizados por la respuesta.
     *
     * @param {Object} data Datos de archivos que utiliza code, size, content.
     * @returns {Promise<*>|null} Datos de la operación; los errores se propagan como ApplicationError.
     */
    async getOne(data) {
      this.#accessScope = data.accessScope === undefined ? '' : data.accessScope;

      let outputPath = null;
      let completed  = false;
      try {
        if (data.code == undefined || data.code == '') {
          throw new ApplicationError(400, `${id}-${controller}-E0080:code is required`);
        }
        const size = data.size != undefined ? data.size : '';
        const id   = data.code.split('-')[0];
        this.#document = null;
        this.#document = await filesRepository.getOne(
          {
            _id : id,
          },
          this.#accessScope,
          'view',
        );

        if (!this.#document && data.accessScope === undefined) {
          this.#document = await filesRepository.getPublicOne({ _id: id });
          if (this.#document) this.#accessScope = policy.trustedScopes.guest;
        }
        if (!this.#document) {
          throw new ApplicationError(404, `${id}-${controller}-E0090:image no found`);
        }
        await filesRepository.recordAccess({ _id: id }, this.#accessScope);
        const c        = this.#document.path.split('/');
        const fileName = fs.uniquePath(c[c.length - 1].toLowerCase());
        outputPath = fileName;
        let keyPath = '';
        switch (size) {
          case '050':
            keyPath = `${this.#document.path}@050`;
            break;
          case '100':
            keyPath = `${this.#document.path}@100`;
            break;
          case '200':
            keyPath = `${this.#document.path}@200`;
            break;
          case '300':
            keyPath = `${this.#document.path}@300`;
            break;
          case '500':
            keyPath = `${this.#document.path}@500`;
            break;
          case '1000':
            keyPath = `${this.#document.path}@1000`;
            break;
          default:
            keyPath = `${this.#document.path}`;
            break;
        }
        const contentInput = {
          bucket : `${dependencies.env.BUCKET}`,
          key    : keyPath,
        };
        try {
          const data   = await storage.read(contentInput);
          const buffer = await this.streamToBuffer(data.content);
          await fs.promises.writeFile(fileName, buffer);
          completed = true;
          return {
            tempFilePath : fileName,
            error        : false,
            code         : 200,
            description  : 'ok',
          };
        } catch (err) {
          if (err instanceof ApplicationError) throw err;
          if (size != '') {
            try {
              contentInput.key = this.#document.path;
              const data2   = await storage.read(contentInput);
              const buffer2 = await this.streamToBuffer(data2.content);
              await fs.promises.writeFile(fileName, buffer2);
              completed = true;
              return {
                tempFilePath : fileName,
                error        : false,
                code         : 200,
                description  : 'ok',
              };
            } catch (err2) {
              if (err2 instanceof ApplicationError) throw err2;
              throw new ApplicationError(
                500,
                `${id}-${controller}-E0090:Error trying to find file (retry)`,
              );
            }
          } else {
            throw new ApplicationError(500, `${id}-${controller}-E0090:Error trying to find file`);
          }
        }
      } catch (err) {
        if (err instanceof ApplicationError) throw err;
        logger.error({
          event     : 'operation_failed',
          component : 'storage',
          code      : 'OPERATION_FAILED',
        });
        throw new ApplicationError(500, 'OPERATION_FAILED');
      } finally {
        if (outputPath && !completed)
          await fs.remove(outputPath).catch(
            /**
             * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
             * @returns {void} Finaliza después de aplicar los efectos de la operación.
             */
            () => {},
          );
      }
    }

    /**
     * Acumula los fragmentos de un flujo y los reúne en un Buffer al finalizar.
     *
     * @param {Object} stream Flujo legible cuyo contenido se reúne en memoria.
     * @returns {Promise<Buffer>} Contenido completo del flujo recibido.
     */
    async streamToBuffer(stream) {
      return new Promise(
        /**
         * Coordina la resolución o el rechazo de la operación asíncrona.
         * @param {Function} resolve Continuación que confirma el resultado de la promesa.
         * @param {Function} reject Continuación que rechaza la promesa con su causa.
         * @returns {void} Finaliza después de aplicar los efectos de la operación.
         */
        (resolve, reject) => {
          const chunks = [];
          stream.on(
            'data',

            /**
             * Atiende el evento emitido por el colaborador.
             * @param {*} chunk Valor de chunk utilizado por esta operación.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            (chunk) => chunks.push(chunk),
          );
          stream.on(
            'end',

            /**
             * Atiende el evento emitido por el colaborador.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            () => resolve(Buffer.concat(chunks)),
          );
          stream.on('error', reject);
        },
      );
    }
    /**
     * Localiza el registro de archivos, aplica los cambios admitidos por esta operación y los persiste.
     * Confirma el consumo y su hecho de configuración para el canal realtime estándar.
     *
     * @param {Object} data Datos de archivos que utiliza code, fileName, tempFilePath, scope, module,
     * userCode, thumbnail.
     * @returns {Promise<*>|null} Datos de la operación; los errores se propagan como ApplicationError.
     */
    async update(data) {
      this.#accessScope = data.accessScope === undefined ? '' : data.accessScope;

      let effectStarted    = false;
      const temporaryPaths = new Set();
      try {
        if (data.tempFilePath) await fs.validate(data.tempFilePath);
        if (!['public', 'private'].includes(data.scope))
          throw new ApplicationError(400, 'FILE_SCOPE_INVALID');
        const system                = messaging.getContext();
        const id                    = data.code.split('-')[0];
        const fileNameUploadedSplit = data.fileName.split('.');
        const extension             = fileNameUploadedSplit[fileNameUploadedSplit.length - 1];
        const stats                 = await fs.promises.stat(data.tempFilePath);
        const size                  = stats.size;
        const fileName              = `${id}-${new Date().getMilliseconds()}`;
        const path                  = `${data.scope}/${data.module}/${fileName}.${extension}`;
        const rawLink               = `${awsS3Url}/${dependencies.env.BUCKET}/${path}`;
        if (ALLOWED_EXTENSIONS.indexOf(extension.toLowerCase()) < 0) {
          throw new ApplicationError(400, `${id}-${controller}-E0006:Extensions not allowed`);
        }
        this.#document = null;
        this.#document = await filesRepository.getOne(
          {
            _id : id,
          },
          this.#accessScope,
          'update',
        );

        let sizeBefore = 0;
        if (!this.#document) {
          const body = {
            _id           : id,
            module        : data.module,
            fileName      : `${fileName}.${extension}`,
            path          : path,
            fileNameReal  : data.fileName,
            rawLink       : rawLink,
            type          : 'file',
            size,
            extension,
            userCreate    : system.user?.userCode || '',
            workspace     : data.workspace === undefined ? system.workspace : data.workspace,
            userAssigned  : data.userAssigned === undefined ? '' : data.userAssigned,
            thumbnail     : data.thumbnail != undefined ? data.thumbnail : false,
            scope         : data.scope,
            idTransaction : system.idTransaction,
          };
          if (!policy.authorize('create', body, this.#accessScope, system))
            throw new ApplicationError(403, 'FILE_ACCESS_DENIED');
          this.#document = await filesRepository.create(body, this.#accessScope);
        } else {
          sizeBefore = this.#document.size;
        }
        const pathToDelete = this.#document.path;
        this.#document.fileName = `${fileName}.${extension}`;
        const resourcepath = `${data.scope}/${data.module}/${fileName}.${extension}`;
        this.#document.updateDate = new Date().getTime();
        this.#document.extension = extension;
        ((this.#document.thumbnail = data.thumbnail != undefined ? data.thumbnail : false),
          (this.#document.size = size));
        this.#document.scope = data.scope;
        this.#document.path = resourcepath;
        await filesRepository.updateItem(this.#document, this.#accessScope);
        if (this.#document.thumbnail) {
          const outputFile050  = `${dependencies.env.TEMP}/${fileName}.${extension}@050`;
          const outputFile100  = `${dependencies.env.TEMP}/${fileName}.${extension}@100`;
          const outputFile200  = `${dependencies.env.TEMP}/${fileName}.${extension}@200`;
          const outputFile300  = `${dependencies.env.TEMP}/${fileName}.${extension}@300`;
          const outputFile500  = `${dependencies.env.TEMP}/${fileName}.${extension}@500`;
          const outputFile1000 = `${dependencies.env.TEMP}/${fileName}.${extension}@1000`;
          temporaryPaths.add(outputFile050);
          await images.resizeFile(data.tempFilePath, 50, await fs.validate(outputFile050));
          temporaryPaths.add(outputFile100);
          await images.resizeFile(data.tempFilePath, 100, await fs.validate(outputFile100));
          temporaryPaths.add(outputFile200);
          await images.resizeFile(data.tempFilePath, 200, await fs.validate(outputFile200));
          temporaryPaths.add(outputFile300);
          await images.resizeFile(data.tempFilePath, 300, await fs.validate(outputFile300));
          temporaryPaths.add(outputFile500);
          await images.resizeFile(data.tempFilePath, 500, await fs.validate(outputFile500));
          temporaryPaths.add(outputFile1000);
          await images.resizeFile(data.tempFilePath, 1000, await fs.validate(outputFile1000));
          const deleteKeys = [50, 100, 200, 300, 500, 1000];
          for (const size of deleteKeys) {
            try {
              effectStarted = true;
              await storage.delete({
                bucket : `${dependencies.env.BUCKET}`,
                key    : `${pathToDelete}@${size}`,
              });
            } catch (err) {
              if (err instanceof ApplicationError) throw err;
              logger.error({
                event     : 'operation_failed',
                component : 'storage',
                code      : 'OPERATION_FAILED',
              });
            }
          }
          const uploads = [
            {
              path : outputFile050,
              key  : `${this.#document.path}@050`,
            },
            {
              path : outputFile100,
              key  : `${this.#document.path}@100`,
            },
            {
              path : outputFile200,
              key  : `${this.#document.path}@200`,
            },
            {
              path : outputFile300,
              key  : `${this.#document.path}@300`,
            },
            {
              path : outputFile500,
              key  : `${this.#document.path}@500`,
            },
            {
              path : outputFile1000,
              key  : `${this.#document.path}@1000`,
            },
          ];
          for (const upload of uploads) {
            effectStarted = true;
            await storage.put({
              content : await fs.promises.readFile(upload.path),
              bucket  : `${dependencies.env.BUCKET}`,
              key     : upload.key,
            });
          }
          await Promise.all([
            fs.promises.unlink(outputFile050),
            fs.promises.unlink(outputFile100),
            fs.promises.unlink(outputFile200),
            fs.promises.unlink(outputFile300),
            fs.promises.unlink(outputFile500),
            fs.promises.unlink(outputFile1000),
          ]);
        }
        const contentInput = {
          bucket : `${dependencies.env.BUCKET}`,
          key    : `${pathToDelete}`,
        };
        effectStarted = true;
        await storage.delete(contentInput);
        const contentInput2 = {
          content : await fs.promises.readFile(data.tempFilePath),
          bucket  : `${dependencies.env.BUCKET}`,
          key     : `${this.#document.path}`,
        };
        try {
          effectStarted = true;
          await storage.put(contentInput2);
          await settingsRepository.adjustUsedSpace(
            +size - sizeBefore,
            settingsPolicy.trustedScopes.guest,
          );
          const urlResource = fileResourceUrl(
            publicOrigin,
            data.scope,
            `${fileName}.${extension.toLowerCase()}`,
          );
          await fs.promises.unlink(data.tempFilePath);
          return {
            urlResource : urlResource,
            rawLink     : rawLink,
            error       : false,
            code        : 200,
            description : 'ok',
          };
        } catch (err) {
          if (err instanceof ApplicationError) throw err;
          throw new ApplicationError(500, `${id}-${controller}-E0090:Error trying save at AWS S3`);
        }
      } catch (err) {
        if (effectStarted)
          throw new ApplicationError(500, 'STORAGE_WRITE_UNCERTAIN', {
            uncertain : true,
            cause     : err,
          });
        if (err instanceof ApplicationError) throw err;
        logger.error({
          event     : 'operation_failed',
          component : 'storage',
          code      : 'OPERATION_FAILED',
        });
        throw new ApplicationError(500, 'OPERATION_FAILED');
      } finally {
        if (data?.cleanTemp !== false)
          await fs.remove(data?.tempFilePath).catch(
            /**
             * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
             * @returns {void} Finaliza después de aplicar los efectos de la operación.
             */
            () => {},
          );
        for (const filename of temporaryPaths)
          await fs.remove(filename).catch(
            /**
             * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
             * @returns {void} Finaliza después de aplicar los efectos de la operación.
             */
            () => {},
          );
      }
    }

    /**
     * Localiza y elimina el registro de archivos y coordina las operaciones asociadas presentes en este
     * flujo.
     * Confirma el consumo y su hecho de configuración para el canal realtime estándar.
     *
     * @param {Object} data Datos de archivos que utiliza code, urlResorce.
     * @returns {Promise<null|Object>} Datos de la operación; los errores se propagan como ApplicationError.
     */
    async delete(data) {
      this.#accessScope = data.accessScope === undefined ? '' : data.accessScope;

      let effectStarted = false;
      try {
        this.#document = null;
        let id;
        if (data.code != undefined && data.code != '') {
          id = data.code.split('-')[0];
          this.#document = await filesRepository.getOne(
            {
              _id : id,
            },
            this.#accessScope,
            'delete',
          );
        } else {
          if (data.urlResorce != undefined && data.urlResorce != '') {
            const urlArray = data.urlResorce.split('/');
            const code     = urlArray[urlArray.length - 1];
            id = code.split('-')[0];
            this.#document = await filesRepository.getOne(
              {
                _id : id,
              },
              this.#accessScope,
              'delete',
            );
          } else {
            throw new ApplicationError(400, `${id}-${controller}-E0090:code is required`);
          }
        }
        if (!this.#document) {
          return null;
        }
        const sizeToFree = this.#document.size;
        await filesRepository.deleteOne(
          {
            _id : id,
          },
          false,
          this.#accessScope,
        );
        effectStarted = true;
        await storage.delete({
          bucket : `${dependencies.env.BUCKET}`,
          key    : `${this.#document.path}`,
        });
        let sizeThumbnail = 0;
        if (this.#document.thumbnail) {
          const sizes = ['050', '100', '200', '300', '500', '1000'];
          for (const size of sizes) {
            const thumbnailKey = `${this.#document.path}@${size}`;
            try {
              const headResp = await storage.head({
                bucket : `${dependencies.env.BUCKET}`,
                key    : thumbnailKey,
              });
              if (headResp && headResp.size) {
                sizeThumbnail += headResp.size;
              }
              effectStarted = true;
              await storage.delete({
                bucket : `${dependencies.env.BUCKET}`,
                key    : thumbnailKey,
              });
            } catch (err) {
              if (err instanceof ApplicationError) throw err;
              logger.error({
                event     : 'operation_failed',
                component : 'storage',
                code      : 'OPERATION_FAILED',
              });
            }
          }
        }
        await settingsRepository.adjustUsedSpace(
          -sizeToFree - sizeThumbnail,
          settingsPolicy.trustedScopes.guest,
        );
        return this.#document;
      } catch (err) {
        if (effectStarted)
          throw new ApplicationError(500, 'STORAGE_WRITE_UNCERTAIN', {
            uncertain : true,
            cause     : err,
          });
        if (err instanceof ApplicationError) throw err;
        logger.error({
          event     : 'operation_failed',
          component : 'storage',
          code      : 'OPERATION_FAILED',
        });
        throw new ApplicationError(500, 'OPERATION_FAILED');
      }
    }

    /**
     * Duplica el archivo y sus metadatos siguiendo las opciones recibidas.
     * Confirma el consumo y su hecho de configuración para el canal realtime estándar.
     *
     * @param {Object} data Datos de archivos que utiliza code, urlResorce, content.
     * @returns {Promise<null|Promise<*>|Object>} Datos de la operación; los errores se propagan como ApplicationError.
     */
    async clone(data) {
      this.#accessScope = data.accessScope === undefined ? '' : data.accessScope;

      let effectStarted    = false;
      const temporaryPaths = new Set();
      const system         = messaging.getContext();
      this.#document = null;
      let id;
      if (data.code != undefined && data.code != '') {
        id = data.code.split('-')[0];
        this.#document = await filesRepository.getOne(
          {
            _id : id,
          },
          this.#accessScope,
          'view',
        );
      } else {
        if (data.urlResorce != undefined && data.urlResorce != '') {
          const urlArray = data.urlResorce.split('/');
          const code     = urlArray[urlArray.length - 1];
          id = code.split('-')[0];
          this.#document = await filesRepository.getOne(
            {
              _id : id,
            },
            this.#accessScope,
            'view',
          );
        } else {
          throw new ApplicationError(400, `${id}-${controller}-E0090:code/urlResorce is required`);
        }
      }
      if (!this.#document) throw new ApplicationError(403, 'FILE_ACCESS_DENIED');
      if (
        !policy.authorize(
          'create',
          {
            workspace    : data.workspace === undefined ? system.workspace : data.workspace,
            userAssigned : data.userAssigned === undefined ? '' : data.userAssigned,
          },
          this.#accessScope,
          system,
        )
      )
        throw new ApplicationError(403, 'FILE_ACCESS_DENIED');
      try {
        const newId    = dependencies.newFileId();
        const path     = `${this.#document.scope}/${this.#document.module}`;
        const fileName = `${newId}-${new Date().getMilliseconds()}`;
        const rawLink  = `${awsS3Url}/${dependencies.env.BUCKET}/${path}/${fileName}.${this.#document.extension}`;
        const body     = {
          _id           : newId,
          module        : this.#document.module,
          fileName      : `${fileName}.${this.#document.extension}`,
          path          : `${path}/${fileName}.${this.#document.extension}`,
          rawLink       : rawLink,
          type          : 'file',
          fileNameReal  : this.#document.fileName,
          userCreate    : system.user?.userCode || '',
          workspace     : data.workspace === undefined ? system.workspace : data.workspace,
          userAssigned  : data.userAssigned === undefined ? '' : data.userAssigned,
          private       : this.#document.private === true,
          scope         : this.#document.scope,
          thumbnail     : this.#document.thumbnail,
          size          : this.#document.size,
          extension     : this.#document.extension,
          idTransaction : system.idTransaction,
        };
        if (!policy.authorize('create', body, this.#accessScope, system))
          throw new ApplicationError(403, 'FILE_ACCESS_DENIED');
        const clonedDocument = await filesRepository.create(body, this.#accessScope);
        const storedObject   = await storage.read({
          bucket : `${dependencies.env.BUCKET}`,
          key    : this.#document.path,
        });
        const buffer         = await this.streamToBuffer(storedObject.content);
        const originFile     = fs.uniquePath(fileName);
        temporaryPaths.add(originFile);
        await fs.promises.writeFile(originFile, buffer);
        if (clonedDocument.thumbnail) {
          const outputFile050  = `${originFile}@050`;
          const outputFile100  = `${originFile}@100`;
          const outputFile200  = `${originFile}@200`;
          const outputFile300  = `${originFile}@300`;
          const outputFile500  = `${originFile}@500`;
          const outputFile1000 = `${originFile}@1000`;
          const sizes          = [
            {
              width     : 50,
              output    : outputFile050,
              keySuffix : '@050',
            },
            {
              width     : 100,
              output    : outputFile100,
              keySuffix : '@100',
            },
            {
              width     : 200,
              output    : outputFile200,
              keySuffix : '@200',
            },
            {
              width     : 300,
              output    : outputFile300,
              keySuffix : '@300',
            },
            {
              width     : 500,
              output    : outputFile500,
              keySuffix : '@500',
            },
            {
              width     : 1000,
              output    : outputFile1000,
              keySuffix : '@1000',
            },
          ];
          for (const size of sizes) {
            temporaryPaths.add(size.output);
            await images.resizeFile(originFile, size.width, await fs.validate(size.output));
            effectStarted = true;
            await storage.put({
              content : await fs.promises.readFile(size.output),
              bucket  : `${dependencies.env.BUCKET}`,
              key     : `${clonedDocument.path}${size.keySuffix}`,
            });
            await fs.promises.unlink(size.output);
          }
        }
        try {
          effectStarted = true;
          await storage.put({
            content : await fs.promises.readFile(originFile),
            bucket  : `${dependencies.env.BUCKET}`,
            key     : `${path}/${fileName}.${clonedDocument.extension}`,
          });
          await settingsRepository.adjustUsedSpace(
            +clonedDocument.size,
            settingsPolicy.trustedScopes.guest,
          );
          const urlResource = fileResourceUrl(
            publicOrigin,
            clonedDocument.scope,
            `${fileName}.${clonedDocument.extension.toLowerCase()}`,
          );
          await fs.promises.unlink(originFile);
          return {
            urlResource : urlResource,
            rawLink     : rawLink,
            error       : false,
            code        : 201,
            description : 'ok',
          };
        } catch (err) {
          if (err instanceof ApplicationError) throw err;
          logger.error({
            event     : 'operation_failed',
            component : 'storage',
            code      : 'OPERATION_FAILED',
          });
          throw new ApplicationError(
            500,
            `${id}-${controller}-E0090:Error trying to upload file to AWS S3`,
          );
        }
      } catch (err) {
        if (effectStarted)
          throw new ApplicationError(500, 'STORAGE_WRITE_UNCERTAIN', {
            uncertain : true,
            cause     : err,
          });
        if (err instanceof ApplicationError) throw err;
        logger.error({
          event     : 'operation_failed',
          component : 'storage',
          code      : 'OPERATION_FAILED',
        });
        throw new ApplicationError(500, `${id}-${controller}-E0102:Error al clonar archivo`);
      } finally {
        for (const filename of temporaryPaths)
          await fs.remove(filename).catch(
            /**
             * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
             * @returns {void} Finaliza después de aplicar los efectos de la operación.
             */
            () => {},
          );
      }
    }
  };
};
