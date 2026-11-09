/** @file DTO de entrada y salida de las acciones de settings; reutilizan los esquemas vigentes del servicio. */
'use strict';
const { createActionDtos } = require('../../../contracts/action-dto');
const settingsActionDtos   = createActionDtos([
  'settings-get-one',
  'settings-get-list',
  'settings-update',
]);
module.exports = settingsActionDtos;
