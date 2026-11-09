/** @file DTO de entrada y salida de las acciones de pdf; reutilizan los esquemas vigentes del servicio. */
'use strict';
const { createActionDtos } = require('../../../contracts/action-dto');
const pdfActionDtos        = createActionDtos([
  'pdf-billing-create',
  'pdf-billing-commercial-create',
  'pdf-rich-description-create',
  'pdf-quote-create',
  'pdf-cnr-create',
  'pdf-purchase-order-create',
  'pdf-invoice-create',
  'pdf-invoice-cancel-create',
  'pdf-complement-create',
]);
module.exports = pdfActionDtos;
