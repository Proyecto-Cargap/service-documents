/** @file Renderizado Chromium y unión PDF; los casos de uso aportan HTML y rutas validadas. */
'use strict';
/**
 * Compone createPdfRenderer con las dependencias recibidas y devuelve su interfaz.
 * @param {Object} options Colaboradores u opciones: puppeteer, PDFMerger, temporaryFiles, logger, createPdfError, pdfErrors.
 * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function createPdfRenderer({
  puppeteer,
  PDFMerger,
  temporaryFiles,
  logger,
  createPdfError,
  pdfErrors,
}) {
  /**
   * Ejecuta renderPdf dentro del flujo de pdf-renderer.
   * @param {*} renderedHtml Valor de renderedHtml utilizado por esta operación.
   * @param {*} filePath Valor de filePath utilizado por esta operación.
   * @param {Object} [options] Opciones que delimitan el comportamiento de la operación.
   * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
   */
  const renderPdf = async (renderedHtml, filePath, options = {}) => {
    await temporaryFiles.validate(filePath);
    let browser = null;
    let stage   = 'launch';
    try {
      const { setContentOptions = {}, ...pdfOptions } = options;
      browser = await puppeteer.launch({
        headless : true,
        args     : ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      stage = 'render';
      const page = await browser.newPage();
      await page.setJavaScriptEnabled(false);
      await page.setContent(renderedHtml, setContentOptions);
      await page.pdf({
        path            : filePath,
        format          : 'A4',
        printBackground : true,
        ...pdfOptions,
      });
    } catch (error) {
      if (stage === 'launch') {
        throw createPdfError(pdfErrors.browserUnavailable, error);
      }
      if (['EACCES', 'ENOENT', 'ENOSPC', 'EPERM'].includes(error?.code)) {
        throw createPdfError(pdfErrors.temporaryDirectory, error);
      }
      throw createPdfError(pdfErrors.render, error);
    } finally {
      if (browser) {
        await browser.close().catch(
          /**
           * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
           * @param {Error} error Fallo recibido por la continuación.
           * @returns {void} Finaliza después de aplicar los efectos de la operación.
           */
          (error) => {
            logger.error({
              event     : 'operation_failed',
              component : 'rendering',
              code      : 'OPERATION_FAILED',
            });
          },
        );
      }
    }
  };
  return {
    renderPdf,
    /**
     * Ejecuta mergePdf dentro del flujo de pdf-renderer.
     * @param {*} inputs Valor de inputs utilizado por esta operación.
     * @param {*} destination Valor de destination utilizado por esta operación.
     * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
     */
    async mergePdf(inputs, destination) {
      const merger = new PDFMerger();
      for (const filename of inputs) {
        await temporaryFiles.promises.access(filename);
        await merger.add(filename);
      }
      await temporaryFiles.validate(destination);
      await merger.save(destination);
    },
  };
}
module.exports = { createPdfRenderer };
