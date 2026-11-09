/** @file DTO de entrada y salida de las acciones de qrcode; reutilizan los esquemas vigentes del servicio. */
'use strict';
const { createActionDtos } = require('../../../contracts/action-dto');
const qrcodeActionDtos     = createActionDtos(['qrcode-create', 'qrcode-decode']);
module.exports = qrcodeActionDtos;
