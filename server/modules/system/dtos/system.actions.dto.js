/** @file DTO de entrada y salida de las acciones de system; reutilizan los esquemas vigentes del servicio. */
'use strict';
const { createActionDtos } = require('../../../contracts/action-dto');
const systemActionDtos     = createActionDtos(['health', 'service-contracts-get']);
module.exports = systemActionDtos;
