/** @file Pie administrativo del PDF: ruta confinada, datos escapados y comportamiento sin pie preservado. */
'use strict';
const test                     = require('node:test');
const assert                   = require('node:assert/strict');
const fs                       = require('node:fs/promises');
const path                     = require('node:path');
const os                       = require('node:os');
const handlebars               = require('handlebars');
const pdfService               = require('../server/modules/pdf/services/pdf.service');
const { createTemporaryFiles } = require('../server/adapters/filesystem/temporary-files');
const { approvedAsset }        = require('../server/adapters/rendering/pdf-registry');

test('el pie aprobado conserva escape, aislamiento y generación sin configuración opcional', /** @returns {Promise<void>} Usa archivos reales y sustituye únicamente Chromium para verificar sus opciones de impresión. */ async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'documents-pdf-footer-')));
  const temp = path.join(root, 'temp');
  await fs.mkdir(temp);
  await fs.writeFile(path.join(root, 'body.html'), '<h1>{{reference}}</h1>');
  await fs.writeFile(
    path.join(root, 'footer.html'),
    '<span>{{reference}}</span><span class="pageNumber"></span>',
  );
  const entry          = {
    path   : 'body.html',
    footer : 'footer.html',
  };
  const registry       = {
    assetRoot : root,
    issuer    : { name: 'Prueba' },
    currency  : 'MXN',
    locale    : 'es-MX',
    timeZone  : 'America/Mexico_City',
    templates : { quote: entry },
    annexes   : {},
  };
  const temporaryFiles = createTemporaryFiles({
    root      : temp,
    readRoots : [root],
  });
  const calls          = [];
  let fail             = false;
  const PdfService     = pdfService({
    env         : { TEMP: temp },
    temporaryFiles,
    handlebars,
    logger      : {
      /** @returns {void} El error queda acreditado por su código público en la prueba. */
      error() {},
    },
    pdfRegistry : {
      /** @returns {Object} Registro administrativo controlado por la prueba. */
      load  : () => registry,
      asset : approvedAsset,
    },
    /** @returns {Object} Sustituye el proceso Chromium y conserva escritura/limpieza reales. */
    createRenderer() {
      return {
        /** @param {string} html Cuerpo compilado. @param {string} file Archivo temporal. @param {Object} options Configuración de impresión. @returns {Promise<void>} Simula éxito o fallo después de escribir el temporal. */
        async renderPdf(html, file, options) {
          calls.push({
            html,
            options,
          });
          await fs.writeFile(file, '%PDF-1.7\n');
          if (fail) throw new Error('RENDER_FAILED');
        },
      };
    },
  });
  const service        = new PdfService();
  const input          = { quotation: { reference: '<img src=x onerror=alert(1)>' } };
  try {
    const first = await service.quoteCreate(input);
    assert.equal(calls[0].options.displayHeaderFooter, true);
    assert.equal(calls[0].options.headerTemplate, '<span></span>');
    assert.ok(calls[0].options.footerTemplate.includes('&lt;img'));
    assert.ok(!calls[0].options.footerTemplate.includes('<img'));
    await temporaryFiles.remove(first.tempFilePath);
    delete entry.footer;
    const second = await service.quoteCreate(input);
    assert.deepEqual(calls[1].options, { preferCSSPageSize: true });
    await temporaryFiles.remove(second.tempFilePath);
    entry.footer = '../footer.html';
    await assert.rejects(service.quoteCreate(input), {
      descriptionCode : 'PDF_APPROVED_ASSET_UNAVAILABLE',
    });
    assert.equal(calls.length, 2);
    entry.footer = 'footer.html';
    fail = true;
    await assert.rejects(service.quoteCreate(input), {
      descriptionCode : 'PDF_RENDER_FAILED',
    });
    assert.deepEqual(await fs.readdir(temp), []);
  } finally {
    await fs.rm(root, {
      recursive : true,
      force     : true,
    });
  }
});
