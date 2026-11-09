/**
 * @file Saneamiento del HTML enriquecido utilizado por las plantillas PDF: contenido permitido, imágenes
 * y enlaces.
 */
'use strict';

/**
 * Compone createRichHtml con las dependencias recibidas y devuelve su interfaz.
 * @param {Object} dependencies Colaboradores explícitos de la composición.
 * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
module.exports = function createRichHtml(dependencies) {
  const sanitizeHtml = dependencies.sanitizeHtml;
  const publicOrigin = dependencies.env.END_POINT
    ? require('../../../shared/endpoint-origin').endpointOrigin(dependencies.env.END_POINT)
    : undefined;
  const COLOR_VALUE  = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]+)$/i;

  /**
   * Comprueba si la fuente de imagen pertenece a los formatos y protocolos admitidos por el saneamiento
   * HTML.
   *
   * @param {*} source Contenido o ruta de origen que se procesa.
   * @returns {boolean} Indica si el origen de imagen está permitido.
   */
  const isAllowedImageSource = (source) => {
    if (typeof source !== 'string' || source.trim() === '') {
      return false;
    }
    if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(source)) {
      return true;
    }
    try {
      const imageUrl = new URL(source);
      if (imageUrl.protocol !== 'https:' || imageUrl.username || imageUrl.password) {
        return false;
      }
      if (publicOrigin && imageUrl.origin === publicOrigin) {
        return imageUrl.pathname.startsWith('/files/');
      }
      if (imageUrl.hostname === 's3.amazonaws.com' && dependencies.env.BUCKET) {
        return imageUrl.pathname.startsWith(`/${dependencies.env.BUCKET}/`);
      }
    } catch (ignoredError) {
      return false;
    }
    return false;
  };

  /**
   * Filtra etiquetas, atributos y recursos del HTML enriquecido antes de renderizarlo en un documento.
   *
   * @param {*} value Valor que se examina o transforma.
   * @returns {string} HTML limitado a las etiquetas, atributos y protocolos admitidos.
   */
  const sanitizeRichHtml = (value) =>
    sanitizeHtml(String(value || ''), {
      allowedTags         : [
        'p',
        'br',
        'strong',
        'b',
        'em',
        'i',
        'u',
        's',
        'strike',
        'blockquote',
        'pre',
        'code',
        'ol',
        'ul',
        'li',
        'h1',
        'h2',
        'h3',
        'h4',
        'a',
        'img',
        'span',
        'div',
        'hr',
      ],
      allowedAttributes   : {
        '*' : ['style'],
        a   : ['href', 'title', 'target', 'rel'],
        img : ['src', 'alt', 'title', 'width', 'height'],
      },
      allowedSchemes      : ['https', 'mailto', 'data'],
      allowedSchemesByTag : {
        a   : ['https', 'mailto'],
        img : ['https', 'data'],
      },
      allowedStyles       : {
        '*' : {
          color              : [COLOR_VALUE],
          'background-color' : [COLOR_VALUE],
          'text-align'       : [/^(left|center|right|justify)$/i],
          'font-weight'      : [/^(normal|bold|[1-9]00)$/i],
          'font-style'       : [/^(normal|italic)$/i],
          'text-decoration'  : [/^(none|underline|line-through)$/i],
        },
      },
      transformTags       : {
        /**
         * Normaliza los enlaces del HTML para abrirlos en otra ventana sin compartir el contexto de navegación.
         *
         * @param {*} ignoredTagName Nombre de la etiqueta recibido por el saneador HTML.
         * @param {*} attribs Atributos del elemento HTML que se transforma.
         * @returns {Object} Objeto con tagName, attribs.
         */
        a : (ignoredTagName, attribs) => ({
          tagName : 'a',
          attribs : {
            ...attribs,
            target : '_blank',
            rel    : 'noopener noreferrer',
          },
        }),
      },
      /**
       * Ejecuta exclusiveFilter dentro del flujo de rich-html.
       * @param {*} frame Valor de frame utilizado por esta operación.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      exclusiveFilter     : (frame) => frame.tag === 'img' && !isAllowedImageSource(frame.attribs?.src),
    });

  /**
   * Comprueba si el HTML saneado conserva texto o contenido visual significativo.
   *
   * @param {*} value Valor que se examina o transforma.
   * @returns {boolean} Indica si el HTML conserva contenido significativo después de sanearlo.
   */
  const hasMeaningfulRichHtml = (value) => {
    const sanitized = sanitizeRichHtml(value);
    if (/<img\b/i.test(sanitized)) {
      return true;
    }
    const text = sanitizeHtml(sanitized, {
      allowedTags       : [],
      allowedAttributes : {},
    })
      .replace(/&(nbsp|#160|#x0*a0);/gi, ' ')
      .replace(/\u00a0/g, ' ')
      .trim();
    return text !== '';
  };
  return {
    hasMeaningfulRichHtml,
    sanitizeRichHtml,
  };
};
