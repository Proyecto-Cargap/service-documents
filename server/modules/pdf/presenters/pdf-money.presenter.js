/** @file Formato monetario de cadenas decimales exactas para plantillas PDF, sin recalcular importes. */
'use strict';

/** @param {string} value Importe decimal canónico de hasta seis posiciones. @param {string} currency Moneda de la versión comercial. @param {number} decimals Precisión mínima acreditada de moneda. @param {string} locale Configuración regional administrativa. @returns {string} Moneda con símbolo, agrupación y decimales significativos; Node 24 recibe la cadena sin conversión a Number. */
function pdfMoney(value, currency, decimals, locale) {
  if (
    typeof value !== 'string' ||
    !/^-?\d+(?:\.\d{1,6})?$/.test(value) ||
    typeof currency !== 'string' ||
    !/^[A-Z]{3}$/.test(currency) ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 6
  )
    throw new TypeError('PDF_MONEY_INVALID');
  const fraction = (value.split('.')[1] || '').replace(/0+$/, '');
  return new Intl.NumberFormat(locale, {
    style                 : 'currency',
    currency,
    currencyDisplay       : 'narrowSymbol',
    minimumFractionDigits : decimals,
    maximumFractionDigits : Math.max(decimals, fraction.length),
  }).format(value);
}

module.exports = { pdfMoney };
