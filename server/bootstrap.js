/** @file Composición del ciclo de vida; importar este módulo no abre conexiones. */
'use strict';
/**
 * Compone createApplication con las dependencias recibidas y devuelve su interfaz.
 * @param {Object} options Colaboradores u opciones: messaging, telemetry, processRef.
 * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function createApplication({ messaging, telemetry, processRef = process }) {
  return {
    /**
     * Inicia el componente y sus colaboradores.
     * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
     */
    async start() {
      messaging.installShutdown(
        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        () => messaging.documentsLifecycle?.close(),
      );
      try {
        await messaging.start();
      } catch (error) {
        telemetry.logger.error({
          component : 'service',
          event     : 'startup_failed',
          code      : error?.code || 'STARTUP_FAILED',
        });
        processRef.stderr.write('[service] startup_failed\n');
        await messaging.documentsLifecycle?.close().catch(
          /**
           * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
           * @returns {void} Finaliza después de aplicar los efectos de la operación.
           */
          () => {},
        );
        await messaging.close().catch(
          /**
           * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
           * @returns {void} Finaliza después de aplicar los efectos de la operación.
           */
          () => {},
        );
        processRef.exitCode = 1;
      }
    },
    /**
     * Cierra el componente y libera sus recursos.
     * @param {Object} options Opciones que delimitan el comportamiento de la operación.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async close(options) {
      await messaging.documentsLifecycle?.close();
      return messaging.close(options);
    },
  };
}
module.exports = { createApplication };
