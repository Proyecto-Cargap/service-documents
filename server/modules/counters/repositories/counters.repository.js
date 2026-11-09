/** @file UUID y secuencias técnicas; filas globales con metadatos canónicos y sin reinterpretar registros históricos. */
'use strict';
const { randomUUID }       = require('node:crypto');
const { pad }              = require('../../../shared/general');
const policy               = require('../policies/counters.policy');
const { ApplicationError } = require('../../../shared/application-error');
/**
 * Compone createCountersRepository con las dependencias recibidas y devuelve su interfaz.
 * @param {Object} options Colaboradores u opciones: model, messaging.
 * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
module.exports = function createCountersRepository({ model, messaging }) {
  return {
    /**
     * Resuelve getObjectCode aplicando los filtros y colaboradores del módulo.
     * @param {*} prefix Valor de prefix utilizado por esta operación.
     * @param {*} [mode] Valor de mode utilizado por esta operación.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async getObjectCode(prefix, mode = 'id') {
      if (typeof prefix !== 'string' || !prefix || !['id', 'code'].includes(mode))
        throw new ApplicationError(400, 'INVALID_INPUT');
      if (mode !== 'code') return prefix + '-' + randomUUID();
      const changes   = { $inc: { seq: 1 } };
      const filter    = policy.authorize('update', { _id: prefix }, policy.trustedScopes.guest, {
        changes,
      });
      /**
       * Ejecuta increment dentro del flujo de counters.repository.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      const increment = () =>
        model.findOneAndUpdate(filter, changes, {
          returnDocument : 'after',
          runValidators  : true,
        });
      let counter     = await increment();
      if (!counter) {
        const context = messaging?.getContext() || {};
        const input   = policy.authorize(
          'create',
          {
            _id          : prefix,
            seq          : 0,
            workspace    : 'allWorkspaces',
            userCreate   : context.user?.userCode || '',
            userAssigned : '',
          },
          policy.trustedScopes.guest,
          context,
        );
        try {
          counter = await model.create(input);
        } catch (error) {
          if (error.code !== 11000) throw error;
          counter = await increment();
          if (!counter) throw error;
        }
      }
      return prefix + pad(counter.seq, 7);
    },
  };
};
