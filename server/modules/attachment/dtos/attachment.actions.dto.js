/** @file DTO de entrada y salida de las acciones de attachment; reutilizan los esquemas vigentes del servicio. */
'use strict';
const { createActionDtos } = require('../../../contracts/action-dto');
const attachmentActionDtos = createActionDtos([
  'attachment-upload',
  'attachment-download',
  'attachment-preview',
  'attachment-delete',
  'attachment-discard',
  'attachment-status',
]);
module.exports = attachmentActionDtos;
