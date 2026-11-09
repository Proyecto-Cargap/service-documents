/** @file Política local uniforme: permisos exactos y filtros de acceso sin mutar la entrada. */
'use strict';

const SERVICE       = 'documents';
const MODULE        = 'workspace';
const trustedScopes = Object.freeze({ guest: Symbol(`${SERVICE}.${MODULE}.guest`) });
const SCOPES        = Object.freeze(['global', 'workspace', 'owner', 'assigned']);

/** Comprueba únicamente los campos que constituyen el contrato de acceso persistido.
 * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function contractFilter() {
  return {
    workspace    : {
      $type : 'string',
      $ne   : '',
    },
    userCreate   : { $type: 'string' },
    userAssigned : { $type: 'string' },
  };
}

/** Aplica una combinación; guest sólo admite el marcador creado en este módulo.
 * @param {string} action Valor de action utilizado por esta operación.
 * @param {*} selectedScope Valor de selectedScope utilizado por esta operación.
 * @param {Object} input Entrada que se procesa con las reglas del módulo.
 * @param {Object} [context] Contexto de identidad y alcance de la operación.
 * @param {string|symbol} [scope] Alcance solicitado o marcador interno de confianza.
 * @returns {null|Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function applyRestriction(action, selectedScope, input, context = {}, scope = '') {
  const isGuest         = selectedScope === 'guest';
  const userCode        = context.user?.userCode;
  const activeWorkspace = context.workspace;
  if (isGuest) {
    if (scope !== trustedScopes.guest) return null;
  } else {
    if (typeof userCode !== 'string' || !userCode) return null;
    if (
      !Array.isArray(context.policies) ||
      !context.policies.includes(`${SERVICE}.${MODULE}.${action}.${selectedScope}`)
    )
      return null;
    if (
      selectedScope !== 'global' &&
      (typeof activeWorkspace !== 'string' ||
        !activeWorkspace ||
        activeWorkspace === 'allWorkspaces')
    )
      return null;
  }
  if (action === 'create') {
    const workspace    = input.workspace === undefined ? activeWorkspace : input.workspace;
    const userCreate   = isGuest ? (input.userCreate ?? userCode ?? '') : userCode;
    const userAssigned = selectedScope === 'assigned' ? userCode : (input.userAssigned ?? '');
    if (
      typeof workspace !== 'string' ||
      !workspace ||
      typeof userCreate !== 'string' ||
      typeof userAssigned !== 'string'
    )
      return null;
    if (
      !isGuest &&
      selectedScope !== 'global' &&
      workspace !== activeWorkspace &&
      workspace !== 'allWorkspaces'
    )
      return null;
    if (
      selectedScope === 'assigned' &&
      input.userAssigned !== undefined &&
      input.userAssigned !== userCode
    )
      return null;
    return {
      ...input,
      workspace,
      userCreate,
      userAssigned,
    };
  }
  const constraints = [{ ...input }, contractFilter()];
  if (!isGuest && selectedScope !== 'global') {
    constraints.push({ workspace: { $in: [activeWorkspace, 'allWorkspaces'] } });
    if (selectedScope === 'owner') constraints.push({ userCreate: userCode });
    if (selectedScope === 'assigned') constraints.push({ userAssigned: userCode });
  }
  if (action === 'update' && context.changes !== undefined) {
    const changes = context.changes;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return null;
    // Los metadatos sólo cambian mediante asignación; otros operadores no pueden eludir el alcance.
    const accessFields = ['workspace', 'userCreate', 'userAssigned'];
    for (const [operator, fields] of Object.entries(changes)) {
      if (!operator.startsWith('$') || !fields || typeof fields !== 'object') continue;
      if (
        operator !== '$set' &&
        Object.keys(fields).some(
          /**
           * Comprueba si el elemento satisface la condición.
           * @param {string} field Campo utilizado por la operación.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          (field) => accessFields.includes(field.split('.')[0]),
        )
      )
        return null;
      if (
        operator === '$rename' &&
        Object.values(fields).some(
          /**
           * Comprueba si el elemento satisface la condición.
           * @param {string} field Campo utilizado por la operación.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          (field) => typeof field === 'string' && accessFields.includes(field.split('.')[0]),
        )
      )
        return null;
    }
    for (const field of Object.keys({
      ...changes,
      ...changes.$set,
    })) {
      if (field.includes('.') && accessFields.includes(field.split('.')[0])) return null;
    }
    const values = {
      ...changes,
      ...changes.$set,
    };
    if (Object.hasOwn(values, 'workspace')) {
      if (typeof values.workspace !== 'string' || !values.workspace) return null;
      if (
        !isGuest &&
        selectedScope !== 'global' &&
        values.workspace !== activeWorkspace &&
        values.workspace !== 'allWorkspaces'
      )
        return null;
    }
    if (Object.hasOwn(values, 'userAssigned') && typeof values.userAssigned !== 'string')
      return null;
    if (Object.hasOwn(values, 'userCreate')) {
      if (typeof values.userCreate !== 'string') return null;
      constraints.push({ userCreate: values.userCreate });
    }
  }
  return { $and: constraints };
}

const restrictions = Object.freeze({
  create : Object.freeze({
    /**
     * Ejecuta guest dentro del flujo de workspace.policy.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @param {Object} context Contexto de identidad y alcance de la operación.
     * @param {string|symbol} scope Alcance solicitado o marcador interno de confianza.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    guest     : (input, context, scope) => applyRestriction('create', 'guest', input, context, scope),
    /**
     * Ejecuta global dentro del flujo de workspace.policy.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @param {Object} context Contexto de identidad y alcance de la operación.
     * @param {string|symbol} scope Alcance solicitado o marcador interno de confianza.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    global    : (input, context, scope) => applyRestriction('create', 'global', input, context, scope),
    /**
     * Ejecuta workspace dentro del flujo de workspace.policy.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @param {Object} context Contexto de identidad y alcance de la operación.
     * @param {string|symbol} scope Alcance solicitado o marcador interno de confianza.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    workspace : (input, context, scope) =>
      applyRestriction('create', 'workspace', input, context, scope),
    /**
     * Ejecuta owner dentro del flujo de workspace.policy.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @param {Object} context Contexto de identidad y alcance de la operación.
     * @param {string|symbol} scope Alcance solicitado o marcador interno de confianza.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    owner     : (input, context, scope) => applyRestriction('create', 'owner', input, context, scope),
    /**
     * Ejecuta assigned dentro del flujo de workspace.policy.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @param {Object} context Contexto de identidad y alcance de la operación.
     * @param {string|symbol} scope Alcance solicitado o marcador interno de confianza.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    assigned  : (input, context, scope) =>
      applyRestriction('create', 'assigned', input, context, scope),
  }),
  view   : Object.freeze({
    /**
     * Ejecuta guest dentro del flujo de workspace.policy.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @param {Object} context Contexto de identidad y alcance de la operación.
     * @param {string|symbol} scope Alcance solicitado o marcador interno de confianza.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    guest     : (input, context, scope) => applyRestriction('view', 'guest', input, context, scope),
    /**
     * Ejecuta global dentro del flujo de workspace.policy.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @param {Object} context Contexto de identidad y alcance de la operación.
     * @param {string|symbol} scope Alcance solicitado o marcador interno de confianza.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    global    : (input, context, scope) => applyRestriction('view', 'global', input, context, scope),
    /**
     * Ejecuta workspace dentro del flujo de workspace.policy.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @param {Object} context Contexto de identidad y alcance de la operación.
     * @param {string|symbol} scope Alcance solicitado o marcador interno de confianza.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    workspace : (input, context, scope) =>
      applyRestriction('view', 'workspace', input, context, scope),
    /**
     * Ejecuta owner dentro del flujo de workspace.policy.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @param {Object} context Contexto de identidad y alcance de la operación.
     * @param {string|symbol} scope Alcance solicitado o marcador interno de confianza.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    owner     : (input, context, scope) => applyRestriction('view', 'owner', input, context, scope),
    /**
     * Ejecuta assigned dentro del flujo de workspace.policy.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @param {Object} context Contexto de identidad y alcance de la operación.
     * @param {string|symbol} scope Alcance solicitado o marcador interno de confianza.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    assigned  : (input, context, scope) =>
      applyRestriction('view', 'assigned', input, context, scope),
  }),
  update : Object.freeze({
    /**
     * Ejecuta guest dentro del flujo de workspace.policy.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @param {Object} context Contexto de identidad y alcance de la operación.
     * @param {string|symbol} scope Alcance solicitado o marcador interno de confianza.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    guest     : (input, context, scope) => applyRestriction('update', 'guest', input, context, scope),
    /**
     * Ejecuta global dentro del flujo de workspace.policy.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @param {Object} context Contexto de identidad y alcance de la operación.
     * @param {string|symbol} scope Alcance solicitado o marcador interno de confianza.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    global    : (input, context, scope) => applyRestriction('update', 'global', input, context, scope),
    /**
     * Ejecuta workspace dentro del flujo de workspace.policy.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @param {Object} context Contexto de identidad y alcance de la operación.
     * @param {string|symbol} scope Alcance solicitado o marcador interno de confianza.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    workspace : (input, context, scope) =>
      applyRestriction('update', 'workspace', input, context, scope),
    /**
     * Ejecuta owner dentro del flujo de workspace.policy.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @param {Object} context Contexto de identidad y alcance de la operación.
     * @param {string|symbol} scope Alcance solicitado o marcador interno de confianza.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    owner     : (input, context, scope) => applyRestriction('update', 'owner', input, context, scope),
    /**
     * Ejecuta assigned dentro del flujo de workspace.policy.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @param {Object} context Contexto de identidad y alcance de la operación.
     * @param {string|symbol} scope Alcance solicitado o marcador interno de confianza.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    assigned  : (input, context, scope) =>
      applyRestriction('update', 'assigned', input, context, scope),
  }),
  delete : Object.freeze({
    /**
     * Ejecuta guest dentro del flujo de workspace.policy.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @param {Object} context Contexto de identidad y alcance de la operación.
     * @param {string|symbol} scope Alcance solicitado o marcador interno de confianza.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    guest     : (input, context, scope) => applyRestriction('delete', 'guest', input, context, scope),
    /**
     * Ejecuta global dentro del flujo de workspace.policy.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @param {Object} context Contexto de identidad y alcance de la operación.
     * @param {string|symbol} scope Alcance solicitado o marcador interno de confianza.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    global    : (input, context, scope) => applyRestriction('delete', 'global', input, context, scope),
    /**
     * Ejecuta workspace dentro del flujo de workspace.policy.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @param {Object} context Contexto de identidad y alcance de la operación.
     * @param {string|symbol} scope Alcance solicitado o marcador interno de confianza.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    workspace : (input, context, scope) =>
      applyRestriction('delete', 'workspace', input, context, scope),
    /**
     * Ejecuta owner dentro del flujo de workspace.policy.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @param {Object} context Contexto de identidad y alcance de la operación.
     * @param {string|symbol} scope Alcance solicitado o marcador interno de confianza.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    owner     : (input, context, scope) => applyRestriction('delete', 'owner', input, context, scope),
    /**
     * Ejecuta assigned dentro del flujo de workspace.policy.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @param {Object} context Contexto de identidad y alcance de la operación.
     * @param {string|symbol} scope Alcance solicitado o marcador interno de confianza.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    assigned  : (input, context, scope) =>
      applyRestriction('delete', 'assigned', input, context, scope),
  }),
});

/**
 * @param {'create'|'view'|'update'|'delete'} action Acción que requiere la operación.
 * @param {Object} input Datos de creación o filtro MongoDB; nunca se modifica.
 * @param {string|symbol} [scope] Alcance explícito, vacío para resolver permisos, o guest local.
 * @param {Object} [context] Identidad, permisos y espacio verificados; changes lleva cambios reales.
 * @returns {Object|null} Datos de creación normalizados o filtro autorizado; null deniega.
 */
function authorize(action, input, scope = '', context = {}) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    !context ||
    typeof context !== 'object' ||
    Array.isArray(context) ||
    typeof action !== 'string' ||
    !Object.hasOwn(restrictions, action)
  )
    return null;
  if (scope === trustedScopes.guest) return restrictions[action].guest(input, context, scope);
  if (typeof scope !== 'string' || (scope !== '' && !SCOPES.includes(scope))) return null;
  if (scope) return restrictions[action][scope](input, context, scope);
  const allowed = [];
  for (const candidate of SCOPES) {
    const result = restrictions[action][candidate](input, context, candidate);
    if (!result) continue;
    if (action === 'create' || candidate === 'global') return result;
    allowed.push(result);
  }
  return allowed.length === 0 ? null : allowed.length === 1 ? allowed[0] : { $or: allowed };
}

module.exports = {
  authorize,
  restrictions,
  trustedScopes,
};
