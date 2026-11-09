/** @file DTO de entrada y salida de las acciones de documents; reutilizan los esquemas vigentes del servicio. */
'use strict';
const { createActionDtos } = require('../../../contracts/action-dto');
const documentsActionDtos  = createActionDtos([
  'documents-repository-manifest-get',
  'documents-repository-resolve',
  'documents-view-get',
  'documents-repositories-get-list',
  'documents-entries-get-list',
  'documents-folder-create',
  'documents-file-upload',
  'documents-settings-get',
  'documents-settings-update',
  'documents-file-upload-prepare',
  'documents-entry-download-prepare',
  'documents-upload-status',
  'documents-entry-get-one',
  'documents-entry-references',
  'documents-entry-rename',
  'documents-entry-move',
  'documents-trash-get-list',
  'documents-entry-restore',
  'documents-entry-delete',
  'documents-entry-download',
  'documents-favorites-get-list',
  'documents-favorite-create',
  'documents-favorite-delete',
]);
module.exports = documentsActionDtos;
