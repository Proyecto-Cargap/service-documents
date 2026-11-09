/** @file Precisión y moneda comercial de los importes PDF, incluido el registro real del helper Handlebars. */
'use strict';
const test                     = require('node:test');
const assert                   = require('node:assert/strict');
const fs                       = require('node:fs/promises');
const path                     = require('node:path');
const os                       = require('node:os');
const handlebars               = require('handlebars');
const { pdfMoney }             = require('../server/modules/pdf/presenters/pdf-money.presenter');
const pdfService               = require('../server/modules/pdf/services/pdf.service');
const { createTemporaryFiles } = require('../server/adapters/filesystem/temporary-files');
const { approvedAsset }        = require('../server/adapters/rendering/pdf-registry');

test('formatea la moneda de la versión sin perder enteros grandes ni decimales significativos', /** @returns {void} Comprueba símbolos, agrupación, precisión y signos sin usar Number para el importe. */ () => {
  for (const [value, currency, decimals, expected] of [
    ['1000.000000', 'MXN', 2, '$1,000.00'],
    ['1234.500000', 'EUR', 2, '€1,234.50'],
    ['1234.500000', 'USD', 2, '$1,234.50'],
    ['1234.000000', 'JPY', 0, '¥1,234'],
    ['9007199254740993.123456', 'MXN', 2, '$9,007,199,254,740,993.123456'],
    ['-0.000001', 'MXN', 2, '-$0.000001'],
    ['0', 'MXN', 2, '$0.00'],
    ['1.5', 'MXN', 3, '$1.500'],
  ])
    assert.equal(pdfMoney(value, currency, decimals, 'es-MX'), expected);
  assert.equal(pdfMoney('12345.5', 'EUR', 2, 'es-ES'), '12.345,50\u00a0€');
});

test('no convierte entradas inválidas en importes aparentes ni sustituye la moneda de la versión', /** @returns {void} Rechaza decimales no canónicos, moneda ausente y precisión inválida. */ () => {
  for (const value of [1000, null, '1e3', '1,000.00', 'NaN', '<script>', '1.1234567'])
    assert.throws(
      /** @returns {string} La entrada inválida debe fallar antes de producir texto monetario. */
      () => pdfMoney(value, 'MXN', 2, 'es-MX'),
      /PDF_MONEY_INVALID/,
    );
  for (const [currency, decimals] of [
    [undefined, 2],
    ['MXN<script>', 2],
    ['MXN', -1],
    ['MXN', 7],
    ['MXN', '2'],
  ])
    assert.throws(
      /** @returns {string} Ninguna entrada recupera silenciosamente una moneda o precisión predeterminada. */
      () => pdfMoney('1', currency, decimals, 'es-MX'),
      /PDF_MONEY_INVALID/,
    );
});

test('el motor registra money con la moneda comercial y conserva currency y el escape existentes', /** @returns {Promise<void>} Usa plantilla y temporales reales; sólo sustituye Chromium para observar el HTML. */ async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'documents-pdf-money-')));
  const temp = path.join(root, 'temp');
  await fs.mkdir(temp);
  await fs.writeFile(
    path.join(root, 'quote.html'),
    '{{#each lines}}{{money unitPrice @root.currency @root.currencyDecimals}};{{/each}}{{money total this.currency currencyDecimals}}|{{currency total}}|{{terms}}',
  );
  const temporaryFiles = createTemporaryFiles({
    root      : temp,
    readRoots : [root],
  });
  const calls          = [];
  const Service        = pdfService({
    env         : { TEMP: temp },
    temporaryFiles,
    handlebars,
    logger      : {
      /** @returns {void} El resultado se comprueba sin registrar datos del documento. */
      error() {},
    },
    pdfRegistry : {
      /** @returns {Object} Registro administrativo cuya moneda difiere de la cotización. */
      load  : () => ({
        assetRoot : root,
        issuer    : { name: 'Emisor sintético' },
        currency  : 'MXN',
        locale    : 'es-MX',
        timeZone  : 'America/Mexico_City',
        templates : { quote: { path: 'quote.html' } },
        annexes   : {},
      }),
      asset : approvedAsset,
    },
    /** @returns {Object} Renderer controlado; no acredita representación visual. */
    createRenderer() {
      return {
        /** @param {string} html Plantilla compilada. @param {string} file Archivo temporal propio. @returns {Promise<void>} Conserva el HTML y produce un temporal para el flujo de limpieza real. */
        async renderPdf(html, file) {
          calls.push(html);
          await fs.writeFile(file, '%PDF-1.7\n');
        },
      };
    },
  });
  try {
    const result = await new Service().quoteCreate({
      quotation : {
        currency         : 'EUR',
        currencyDecimals : 2,
        total            : '1234.500000',
        lines            : [{ unitPrice: '9007199254740993.123456' }],
        terms            : '<b>texto</b>',
      },
    });
    assert.equal(
      calls[0],
      '€9,007,199,254,740,993.123456;€1,234.50|$1,234.50|&lt;b&gt;texto&lt;/b&gt;',
    );
    await temporaryFiles.remove(result.tempFilePath);
    assert.deepEqual(await fs.readdir(temp), []);
  } finally {
    await fs.rm(root, {
      recursive : true,
      force     : true,
    });
  }
});
