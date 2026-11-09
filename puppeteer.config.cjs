/**
 * @file Configuración de Puppeteer para ubicar los recursos de Chromium utilizados por la generación de
 * PDF.
 * Conserva Chrome junto a las dependencias de la release para empaquetarlo. npm ci descarga sólo Chrome;
 * el host utiliza el binario Linux del artefacto. No define credenciales ni rutas particulares de test o
 * producción.
 */
'use strict';

const path = require('node:path');

/** @type {import('puppeteer').Configuration} */
module.exports = {
  cacheDirectory          : path.join(__dirname, 'node_modules', '.cache', 'puppeteer'),
  chrome                  : { skipDownload: false },
  'chrome-headless-shell' : { skipDownload: true },
  firefox                 : { skipDownload: true },
};
