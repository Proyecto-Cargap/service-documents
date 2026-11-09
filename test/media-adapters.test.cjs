/** @file Conformidad de procesamiento de imágenes y QR sin exponer objetos de SDK al dominio. */
'use strict';
const test                = require('node:test');
const assert              = require('node:assert/strict');
const fs                  = require('node:fs/promises');
const path                = require('node:path');
const os                  = require('node:os');
const { imageProcessor }  = require('../server/adapters/media/image-processor');
const { qrProcessor }     = require('../server/adapters/media/qr-processor');
const { attachmentImage } = require('../server/adapters/media/attachment-image');

test('Sharp y el trabajador producen variantes válidas y conservan dimensiones sin ampliar' /**
 * Aplica la operación local y devuelve su resultado al flujo que la invoca.
 * @returns {Promise<*>} Resultado de la operación; los fallos se propagan al flujo invocador.
 */, async () => {
  const sharp     = require('sharp');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'solid-images-'));
  try {
    const source      = path.join(directory, 'source.png');
    const destination = path.join(directory, 'thumb.png');
    await sharp({
      create : {
        width      : 80,
        height     : 40,
        channels   : 3,
        background : '#336699',
      },
    })
      .png()
      .toFile(source);
    const images = imageProcessor(sharp);
    assert.deepEqual(await images.metadata(source), {
      format : 'png',
      width  : 80,
      height : 40,
    });
    await images.resizeFile(source, 40, destination);
    assert.equal((await sharp(destination).metadata()).width, 40);
    const variant = await images.variantPng(source, 100);
    assert.deepEqual(variant.info, {
      width  : 80,
      height : 40,
    });
    assert.equal((await sharp(variant.data).metadata()).format, 'png');
    const workerResult = await attachmentImage(source, path.join(directory, 'preview.webp'));
    assert.ok(workerResult);
    assert.equal((await sharp(path.join(directory, 'preview.webp')).metadata()).format, 'webp');
  } finally {
    await fs.rm(directory, {
      recursive : true,
      force     : true,
    });
  }
});

test('QR propaga escritura y resultados simples y distingue fallos de imagen y lectura' /**
 * Aplica la operación local y devuelve su resultado al flujo que la invoca.
 * @returns {Promise<*>} Resultado de la operación; los fallos se propagan al flujo invocador.
 */, async () => {
  const writes = [];
  class Canvas {
    /**
     * Ejecuta constructor y devuelve el resultado al flujo que lo invoca.
     * @param {*} options Valor utilizado por la operación.
     */
    constructor(options) {
      this.options = options;
    }

    /**
     * Ejecuta toFile y devuelve el resultado al flujo que lo invoca.
     * @param {*} destination Valor utilizado por la operación.
     * @param {*} format Valor utilizado por la operación.
     * @returns {Promise<*>} Resultado de la operación; los fallos se propagan al flujo invocador.
     */
    async toFile(destination, format) {
      writes.push({
        options : this.options,
        destination,
        format,
      });
    }
  }
  class Reader {
    /**
     * Ejecuta decode y devuelve el resultado al flujo que lo invoca.
     * @param {*} bitmap Valor utilizado por la operación.
     * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
     */
    decode(bitmap) {
      assert.equal(bitmap, 'bitmap');
      this.callback(null, { result: 'content' });
    }
  }
  const adapter = qrProcessor({
    QRCodeCanvas : Canvas,
    QrReader     : Reader,
    Jimp         : {
      /**
       * Ejecuta read y devuelve el resultado al flujo que lo invoca.
       * @returns {Promise<*>} Resultado de la operación; los fallos se propagan al flujo invocador.
       */
      read : async () => ({ bitmap: 'bitmap' }),
    },
  });
  await adapter.write({ data: 'content' }, '/private/qr.png');
  assert.deepEqual(writes, [
    {
      options     : { data: 'content' },
      destination : '/private/qr.png',
      format      : 'png',
    },
  ]);
  assert.equal(await adapter.read(Buffer.from('image')), 'content');
  const cause   = new Error('decode');
  const invalid = qrProcessor({
    Jimp : {
      /**
       * Ejecuta read y devuelve el resultado al flujo que lo invoca.
       * @returns {Promise<*>} Resultado de la operación; los fallos se propagan al flujo invocador.
       */
      read : async () => {
        throw cause;
      },
    },
  });
  await assert.rejects(
    invalid.read(Buffer.alloc(0)),
    /**
     * Aplica la operación local y devuelve su resultado al flujo que la invoca.
     * @param {*} error Valor utilizado por la operación.
     * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
     */
    (error) => error.code === 'QR_INVALID_IMAGE' && error.cause === cause,
  );
  class Missing {
    /**
     * Ejecuta decode y devuelve el resultado al flujo que lo invoca.
     * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
     */
    decode() {
      this.callback(cause);
    }
  }
  await assert.rejects(
    qrProcessor({
      QrReader : Missing,
      Jimp     : {
        /**
         * Ejecuta read y devuelve el resultado al flujo que lo invoca.
         * @returns {Promise<*>} Resultado de la operación; los fallos se propagan al flujo invocador.
         */
        read : async () => ({ bitmap: 'b' }),
      },
    }).read(Buffer.alloc(0)),
    /**
     * Aplica la operación local y devuelve su resultado al flujo que la invoca.
     * @param {*} error Valor utilizado por la operación.
     * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
     */
    (error) => error.code === 'QR_NOT_FOUND',
  );
});
