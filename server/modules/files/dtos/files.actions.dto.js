/** @file DTO de entrada y salida de las acciones de files; reutilizan los esquemas vigentes del servicio. */
'use strict';
const { createActionDtos } = require('../../../contracts/action-dto');
const filesActionDtos      = createActionDtos([
  'files-storage-upload',
  'files-storage-read',
  'files-storage-delete',
  'files-storage-public-read',

  'files-create',
  'files-update',
  'files-get-one',
  'files-clone',
  'files-delete',
]);
module.exports = filesActionDtos;
