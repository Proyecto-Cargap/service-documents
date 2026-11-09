/** @file Decodifica imágenes raster y produce WebP privado sin metadatos ni ampliación. */
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const fs                         = require('node:fs/promises');
const sharp                      = require('sharp');

/** Procesa únicamente PNG, JPEG y WebP dentro de los límites de Files.
 * @returns {Promise<void>} Escribe un temporal 0600 y comunica sus dimensiones o un fallo seguro.
 */
async function generate() {
  try {
    sharp.cache(false);
    sharp.concurrency(1);
    const stat = await fs.stat(workerData.filename);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) {
      parentPort.postMessage({ status: 413 });
      return;
    }
    const options  = { limitInputPixels: 40000000 };
    const metadata = await sharp(workerData.filename, options).metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format)) throw new Error('INVALID_IMAGE');
    const { data, info } = await sharp(workerData.filename, options)
      .rotate()
      .resize({
        width              : 800,
        height             : 800,
        fit                : 'inside',
        withoutEnlargement : true,
      })
      .webp({ quality: 80 })
      .timeout({ seconds: 5 })
      .toBuffer({ resolveWithObject: true });
    if (data.length > 2 * 1024 * 1024) throw new Error('INVALID_IMAGE');
    await fs.writeFile(workerData.destination, data, {
      flag : 'wx',
      mode : 0o600,
    });
    parentPort.postMessage({
      width  : info.width,
      height : info.height,
      size   : data.length,
    });
  } catch {
    parentPort.postMessage({ status: 422 });
  }
}
void generate();
