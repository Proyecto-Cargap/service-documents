/**
 * @file Operaciones de aplicación de códigos QR. Coordina las validaciones y las colaboraciones
 * necesarias para cada solicitud.
 */

'use strict';

const { ApplicationError } = require('../../../shared/application-error');
const settingsPolicy       = require('../../settings/policies/settings.policy');
const filesPolicy          = require('../../files/policies/files.policy');
/**
 * Compone la generación y lectura de QR con las dependencias de imágenes y archivos.
 * Los temporales y resultados se mantienen dentro de cada ejecución.
 *
 * @param {Object} dependencies Adaptadores y configuración usados por esta capacidad.
 * @param {Object} dependencies.logger Logger técnico para fallos de almacenamiento o renderizado.
 * @param {Object} dependencies.messaging Contexto de ejecución y cliente de solicitudes/comandos
 * entre servicios.
 * @param {Object} dependencies.settingsRepository Lectura y actualización de parámetros técnicos de
 * archivos y QR.
 * @param {Object} dependencies.identity Identidad del servicio usada en los códigos públicos de
 * error.
 * @param {string} dependencies.identity.id Prefijo de los códigos de error de esta instalación.
 * @param {Object} dependencies.qrProcessor Genera y decodifica imágenes QR mediante un puerto técnico.
 * @param {Object} dependencies.temporaryFiles Rutas temporales únicas, validación de confinamiento
 * y operaciones de archivos.
 * @param {Function} dependencies.filesService Constructor de la operación de archivos que guarda el
 * QR generado.
 * @returns {Function} Constructor QrcodeService; el controller crea una instancia por mensaje.
 */
module.exports = function qrcodeService(dependencies) {
  const logger             = dependencies.logger;
  const messaging          = dependencies.messaging;
  const settingsRepository = dependencies.settingsRepository;
  const { id }             = dependencies.identity;
  const qrProcessor        = dependencies.qrProcessor;
  const fs                 = dependencies.temporaryFiles;
  const filesService       = dependencies.filesService;
  const controller         = 'C006';
  return class QrcodeService {
    /**
     * Genera la imagen QR con las opciones configuradas y la incorpora al almacenamiento de archivos.
     * Consulta mediante RPC la acción files-get-one del servicio service-documents.
     *
     * @param {Object} data Datos de códigos QR que utiliza content, image, dotsColor, backgroundColor,
     * fileName, userCode, accessScope, workspace y userAssigned.
     * @returns {Promise<null|Object>} Datos de la operación; los errores se propagan como ApplicationError.
     */
    async create(data) {
      let output          = null;
      let temporaryImage  = null;
      let temporaryOutput = null;
      let completed       = false;
      try {
        const system = messaging.getContext();
        if (data.content == undefined) {
          throw new ApplicationError(404, `${id}-${controller}-E0001:Content is required`);
        }
        const accessScope = data.accessScope === undefined ? '' : data.accessScope;
        const metadata    = {
          workspace    : data.workspace === undefined ? system.workspace : data.workspace,
          userAssigned : data.userAssigned === undefined ? '' : data.userAssigned,
        };
        if (!filesPolicy.authorize('create', metadata, accessScope, system))
          throw new ApplicationError(403, 'FILE_ACCESS_DENIED');
        let image = null;
        if (data.image != undefined && data.image != '') {
          const pictureSplit    = data.image.split('/');
          const pictureFile     = pictureSplit[pictureSplit.length - 1];
          const pictureResponse = await messaging.request('service-documents', 'files-get-one', {
            code  : pictureFile,
            scope : 'public',
          });
          if (pictureResponse.statusCode == 200) {
            image = pictureResponse.data.tempFilePath;
            temporaryImage = image;
          }
        }
        const qrCodeSettings = await settingsRepository.get(
          'qrcode-settings',
          settingsPolicy.trustedScopes.guest,
        );
        const options        = qrCodeSettings.data;
        if (data.dotsColor != undefined) {
          options.dotsOptions.color = data.dotsColor;
        }
        if (data.backgroundColor != undefined) {
          options.backgroundOptions.color = data.backgroundColor;
        }
        const dataQR = {
          width  : 1000,
          height : 1000,
          data   : data.content,
          ...options,
        };
        if (image != null) {
          dataQR.image = image;
        }
        const fileName     = data.fileName != undefined ? data.fileName : 'qrcode';
        const tempFilePath = fs.uniquePath(fileName + '.png');
        temporaryOutput = tempFilePath;
        await qrProcessor.write(dataQR, await fs.validate(tempFilePath));
        const filesServiceInstance = new filesService();
        const file                 = await filesServiceInstance.create({
          module       : 'files-module',
          scope        : 'public',
          accessScope,
          ...metadata,
          userCode     : data.userCode != undefined ? data.userCode : system.user.userCode,
          fileName     : tempFilePath,
          tempFilePath : tempFilePath,
          cleanTemp    : false,
        });
        output = {
          tempFilePath : tempFilePath,
          urlResource  : file.urlResource,
        };
        completed = true;
        return output;
      } catch (err) {
        if (err instanceof ApplicationError) throw err;
        logger.error({
          event     : 'operation_failed',
          component : 'storage',
          code      : 'OPERATION_FAILED',
        });
        throw new ApplicationError(500, `${id}-${controller}-E0000:Error system`);
      } finally {
        if (temporaryImage)
          await fs.remove(temporaryImage).catch(
            /**
             * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
             * @returns {void} Finaliza después de aplicar los efectos de la operación.
             */
            () => {},
          );
        if (!completed && temporaryOutput)
          await fs.remove(temporaryOutput).catch(
            /**
             * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
             * @returns {void} Finaliza después de aplicar los efectos de la operación.
             */
            () => {},
          );
      }
    }

    /**
     * Lee la imagen y devuelve el contenido que identifica el decodificador QR.
     *
     * @param {Object} data Datos de códigos QR que utiliza tempFilePath.
     * @returns {Promise<*>} Datos de la operación; los errores se propagan como ApplicationError.
     */
    async decode(data) {
      try {
        if (data.tempFilePath) await fs.validate(data.tempFilePath);
        if (data.tempFilePath == undefined) {
          throw new ApplicationError(404, `${id}-${controller}-E0002:tempFilePath is required`);
        }
        const buffer = await fs.promises.readFile(data.tempFilePath);
        const value  = await qrProcessor.read(buffer);
        return value === null ? null : { data: value };
      } catch (err) {
        if (err.code === 'QR_INVALID_IMAGE')
          throw new ApplicationError(404, `${id}-${controller}-E0003:Invalid image`);
        if (err.code === 'QR_NOT_FOUND')
          throw new ApplicationError(404, `${id}-${controller}-E0004:QR code not found`);
        if (err instanceof ApplicationError) throw err;
        logger.error({
          event     : 'operation_failed',
          component : 'storage',
          code      : 'OPERATION_FAILED',
        });
        throw new ApplicationError(500, 'OPERATION_FAILED');
      } finally {
        await fs.remove(data?.tempFilePath).catch(
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
