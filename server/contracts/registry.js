/** @file Registro completo de DTO por dominio; cada acción tiene entrada y salida explícitas. */
'use strict';
module.exports = Object.freeze(
  Object.assign(
    Object.create(null),
    require('../modules/attachment/dtos/attachment.actions.dto'),
    require('../modules/documents/dtos/documents.actions.dto'),
    require('../modules/files/dtos/files.actions.dto'),
    require('../modules/pdf/dtos/pdf.actions.dto'),
    require('../modules/qrcode/dtos/qrcode.actions.dto'),
    require('../modules/settings/dtos/settings.actions.dto'),
    require('../modules/system/dtos/system.actions.dto'),
  ),
);
