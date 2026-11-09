/** @file Motor PDF genérico con identidad, formato y activos aprobados por configuración externa. */
'use strict';
const path                 = require('node:path');
const { randomUUID }       = require('node:crypto');
const { ApplicationError } = require('../../../shared/application-error');
const { pdfMoney }         = require('../presenters/pdf-money.presenter');

/**
 * Compone pdfService con las dependencias recibidas y devuelve su interfaz.
 * @param {Object} dependencies Colaboradores explícitos de la composición.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
module.exports = function pdfService(dependencies) {
  const fs                      = dependencies.temporaryFiles;
  const logger                  = dependencies.logger;
  const renderer                = dependencies.handlebars.create();
  const PDF_ERROR               = {
    browserUnavailable : 'PDF_BROWSER_UNAVAILABLE',
    temporaryDirectory : 'PDF_TEMPORARY_DIRECTORY_UNAVAILABLE',
    render             : 'PDF_RENDER_FAILED',
    merge              : 'PDF_MERGE_FAILED',
  };
  /**
   * Compone createPdfError con las dependencias recibidas y devuelve su interfaz.
   * @param {string} code Identificador público del recurso.
   * @param {Error} cause Causa del fallo que se procesa.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  const createPdfError          = (code, cause) =>
    Object.assign(new Error(code), {
      pdfDescription : code,
      cause,
    });
  const { renderPdf, mergePdf } = dependencies.createRenderer({
    createPdfError,
    pdfErrors : PDF_ERROR,
  });
  /**
   * Ejecuta temporary dentro del flujo de pdf.service.
   * @param {*} kind Valor de kind utilizado por esta operación.
   * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  async function temporary(kind) {
    if (!dependencies.env.TEMP || !path.isAbsolute(dependencies.env.TEMP))
      throw new ApplicationError(503, PDF_ERROR.temporaryDirectory);
    const filename = path.join(dependencies.env.TEMP, `${kind}-${randomUUID()}.pdf`);
    await fs.validate(filename);
    await fs.promises.access(dependencies.env.TEMP, fs.constants.W_OK);
    return filename;
  }
  /**
   * Ejecuta render dentro del flujo de pdf.service.
   * @param {*} kind Valor de kind utilizado por esta operación.
   * @param {Object} input Entrada que se procesa con las reglas del módulo.
   * @param {*} payloadKey Valor de payloadKey utilizado por esta operación.
   * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  async function render(kind, input, payloadKey) {
    let output,
      intermediate,
      completed = false;
    try {
      const payload = input?.[payloadKey];
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        throw new ApplicationError(400, 'PDF_DOCUMENT_REQUIRED');
      const registry = dependencies.pdfRegistry.load();
      const entry    = registry.templates[kind];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        throw new ApplicationError(503, 'PDF_TEMPLATE_NOT_CONFIGURED');
      const templatePath = dependencies.pdfRegistry.asset(registry, entry.path, '.html');
      const requested    = input.annexes ?? [];
      if (
        !Array.isArray(requested) ||
        requested.length > 20 ||
        requested.some(
          /**
           * Comprueba si el elemento satisface la condición.
           * @param {string} name Nombre del componente o recurso.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          (name) => typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(name),
        )
      )
        throw new ApplicationError(400, 'PDF_ANNEX_INVALID');
      const defaults = entry.annexes ?? [];
      if (
        !Array.isArray(defaults) ||
        defaults.length > 20 ||
        defaults.some(
          /**
           * Comprueba si el elemento satisface la condición.
           * @param {string} name Nombre del componente o recurso.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          (name) => typeof name !== 'string',
        )
      )
        throw new ApplicationError(503, 'PDF_CONFIGURATION_REQUIRED');
      const annexes = [...new Set([...defaults, ...requested])].map(
        /**
         * Proyecta cada elemento en la estructura requerida por la operación.
         * @param {string} name Nombre del componente o recurso.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        (name) => {
          if (!Object.hasOwn(registry.annexes, name))
            throw new ApplicationError(400, 'PDF_ANNEX_NOT_APPROVED');
          return dependencies.pdfRegistry.asset(registry, registry.annexes[name], '.pdf');
        },
      );
      const engine  = dependencies.handlebars.create();
      engine.registerHelper(
        'money',
        /** @param {string} value Importe acreditado. @param {string} currency Moneda de la instantánea. @param {number} decimals Precisión mínima de esa moneda. @returns {string} Presentación decimal exacta, sin depender de la moneda predeterminada del registro. */
        (value, currency, decimals) => pdfMoney(value, currency, decimals, registry.locale),
      );
      engine.registerHelper(
        'currency',

        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @param {*} value Valor de value utilizado por esta operación.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        (value) =>
          new Intl.NumberFormat(registry.locale, {
            style    : 'currency',
            currency : registry.currency,
          }).format(Number(value)),
      );
      engine.registerHelper(
        'number',

        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @param {*} value Valor de value utilizado por esta operación.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        (value) => new Intl.NumberFormat(registry.locale).format(Number(value)),
      );
      engine.registerHelper(
        'date',

        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @param {*} value Valor de value utilizado por esta operación.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        (value) =>
          new Intl.DateTimeFormat(registry.locale, {
            timeZone  : registry.timeZone,
            dateStyle : 'medium',
          }).format(new Date(value)),
      );
      engine.registerHelper(
        'ifCond',
        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @param {*} left Valor de left utilizado por esta operación.
         * @param {*} operator Valor de operator utilizado por esta operación.
         * @param {*} right Valor de right utilizado por esta operación.
         * @param {Object} options Opciones que delimitan el comportamiento de la operación.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        function (left, operator, right, options) {
          const checks = {
            /**
             * Ejecuta == dentro del flujo de pdf.service.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            '=='  : () => left == right,
            /**
             * Ejecuta === dentro del flujo de pdf.service.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            '===' : () => left === right,
            /**
             * Ejecuta != dentro del flujo de pdf.service.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            '!='  : () => left != right,
            /**
             * Ejecuta !== dentro del flujo de pdf.service.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            '!==' : () => left !== right,
            /**
             * Ejecuta < dentro del flujo de pdf.service.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            '<'   : () => left < right,
            /**
             * Ejecuta <= dentro del flujo de pdf.service.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            '<='  : () => left <= right,
            /**
             * Ejecuta > dentro del flujo de pdf.service.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            '>'   : () => left > right,
            /**
             * Ejecuta >= dentro del flujo de pdf.service.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            '>='  : () => left >= right,
            /**
             * Ejecuta && dentro del flujo de pdf.service.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            '&&'  : () => left && right,
            /**
             * Ejecuta || dentro del flujo de pdf.service.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            '||'  : () => left || right,
          };
          return checks[operator]?.() ? options.fn(this) : options.inverse(this);
        },
      );
      const html           = await fs.promises.readFile(templatePath, 'utf8');
      const view           = {
        ...structuredClone(payload),
        issuer : structuredClone(registry.issuer),
        format : {
          currency : registry.currency,
          locale   : registry.locale,
          timeZone : registry.timeZone,
        },
      };
      const footerTemplate = entry.footer
        ? engine.compile(
            await fs.promises.readFile(
              dependencies.pdfRegistry.asset(registry, entry.footer, '.html'),
              'utf8',
            ),
          )(view, {
            allowProtoPropertiesByDefault : false,
            allowProtoMethodsByDefault    : false,
          })
        : null;
      output = await temporary(kind);
      intermediate = annexes.length ? await temporary(`${kind}-body`) : output;
      await renderPdf(
        engine.compile(html)(view, {
          allowProtoPropertiesByDefault : false,
          allowProtoMethodsByDefault    : false,
        }),
        intermediate,
        {
          preferCSSPageSize : true,
          ...(footerTemplate
            ? {
                displayHeaderFooter : true,
                headerTemplate      : '<span></span>',
                footerTemplate,
              }
            : {}),
        },
      );
      if (annexes.length) {
        try {
          await mergePdf([intermediate, ...annexes], output);
        } catch (cause) {
          throw createPdfError(PDF_ERROR.merge, cause);
        }
      }
      completed = true;
      return { tempFilePath: output };
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      logger.error({
        component : 'rendering',
        event     : 'operation_failed',
        code      : 'PDF_RENDER_FAILED',
      });
      throw new ApplicationError(500, error.pdfDescription || PDF_ERROR.render);
    } finally {
      if (intermediate && intermediate !== output)
        await fs.remove(intermediate).catch(
          /**
           * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
           * @returns {void} Finaliza después de aplicar los efectos de la operación.
           */
          () => {},
        );
      if (!completed && output)
        await fs.remove(output).catch(
          /**
           * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
           * @returns {void} Finaliza después de aplicar los efectos de la operación.
           */
          () => {},
        );
    }
  }
  return class PdfService {
    /** @param {Object} input Vista comercial cerrada. @returns {Promise<Object>} Nota o recibo sin XML ni QR fiscal. */
    commercialCreate(input) {
      return render('billing-commercial', input, 'document');
    }
    /** @param {Object} input Vista fiscal sin HTML ni rutas. @returns {Promise<Object>} PDF de emisión o recuperación con QR privado y plantilla administrativa de Billing. */
    async billingCreate(input) {
      if (
        !/^https:\/\/verificacfdi\.facturaelectronica\.sat\.gob\.mx\/default\.aspx\?/.test(
          input?.document?.verificationUrl || '',
        )
      )
        throw new ApplicationError(400, 'PDF_BILLING_VERIFICATION_REQUIRED');
      const image = fs.uniquePath('billing-qr.png');
      try {
        await dependencies.qrProcessor.write(
          {
            width             : 320,
            height            : 320,
            data              : input.document.verificationUrl,
            margin            : 20,
            dotsOptions       : { color: '#000000' },
            backgroundOptions : { color: '#ffffff' },
          },
          await fs.validate(image),
        );
        const png = await fs.promises.readFile(image);
        return await render(
          'billing',
          {
            document : {
              ...input.document,
              qrImage : 'data:image/png;base64,' + png.toString('base64'),
            },
          },
          'document',
        );
      } finally {
        await fs.remove(image);
      }
    }

    /**
     * Ejecuta quoteCreate dentro del flujo de pdf.service.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    quoteCreate(input) {
      return render('quote', input, 'quotation');
    }
    /**
     * Ejecuta cnrCreate dentro del flujo de pdf.service.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    cnrCreate(input) {
      return render('cnr', input, 'cnr');
    }
    /**
     * Ejecuta purchaseOrderCreate dentro del flujo de pdf.service.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    purchaseOrderCreate(input) {
      return render('purchaseOrder', input, 'document');
    }
    /**
     * Ejecuta invoiceCreate dentro del flujo de pdf.service.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    invoiceCreate(input) {
      return render('invoice', input, 'document');
    }
    /**
     * Ejecuta invoiceCancelCreate dentro del flujo de pdf.service.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    invoiceCancelCreate(input) {
      return render('invoiceCancel', input, 'document');
    }
    /**
     * Ejecuta complementCreate dentro del flujo de pdf.service.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    complementCreate(input) {
      return render('complement', input, 'document');
    }
    /**
     * Ejecuta richDescriptionCreate dentro del flujo de pdf.service.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async richDescriptionCreate(input) {
      let output,
        completed = false;
      try {
        if (!dependencies.richHtml.hasMeaningfulRichHtml(input?.html))
          throw new ApplicationError(400, 'PDF_DESCRIPTION_REQUIRED');
        output = await temporary('description');
        const html = renderer.compile(
          '<!doctype html><html><head><meta charset="utf-8"></head><body><h1>{{title}}</h1><p>{{reference}}</p>{{{html}}}</body></html>',
        )({
          title     : String(input.title || ''),
          reference : String(input.reference || ''),
          html      : dependencies.richHtml.sanitizeRichHtml(input.html),
        });
        await renderPdf(html, output, {
          margin : {
            top    : '18mm',
            right  : '18mm',
            bottom : '18mm',
            left   : '18mm',
          },
        });
        completed = true;
        return { tempFilePath: output };
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        logger.error({
          component : 'rendering',
          event     : 'operation_failed',
          code      : 'PDF_RENDER_FAILED',
        });
        throw new ApplicationError(500, error.pdfDescription || PDF_ERROR.render);
      } finally {
        if (!completed && output)
          await fs.remove(output).catch(
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
