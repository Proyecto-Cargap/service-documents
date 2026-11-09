/** @file Repositorios documentales DB-first con autorización de raíces, cuotas y journal durable. */
'use strict';
const { readAll }                = require('../../../shared/bounded-read');
const { createHash, randomUUID } = require('node:crypto');
const { trashRetentionDays }     = require('../../../shared/document-retention');
const { ApplicationError }       = require('../../../shared/application-error');
const {
  resourceSubject,
  resourceNamespace,
} = require('../../repositories/contracts/resource-subject');
const rootPolicies         = {
  personal  : require('../../personal/policies/personal.policy'),
  workspace : require('../../workspace/policies/workspace.policy'),
  global    : require('../../global/policies/global.policy'),
};
const rootGuest            = require('../../repositories/policies/repositories.policy').trustedScopes.guest;
const entryGuest           = require('../../entries/policies/entries.policy').trustedScopes.guest;
const favoriteGuest        = require('../../favorites/policies/favorites.policy').trustedScopes.guest;
const operationGuest       = require('../../operations/policies/operations.policy').trustedScopes.guest;
const settingsGuest        = require('../../settings/policies/settings.policy').trustedScopes.guest;
const ACTIONS              = ['view', 'create', 'update', 'delete'];
const KIND_SCOPES          = {
  personal  : ['global', 'owner'],
  workspace : ['global', 'workspace'],
  global    : ['global'],
};
const MAX_UPLOAD           = 200 * 1024 * 1024;
const LEASE_MS             = 120000;
const STORAGE_SETTLE_MS    = 120000;
const ABANDONED_RECHECK_MS = 3600000;

/**
 * Coordina un catálogo MongoDB independiente y versiones S3 opacas; construir no abre conexiones.
 * @param {Object} dependencies Repositorios locales, conexión, almacenamiento y temporales inyectados.
 * @returns {Object} Operaciones públicas y ciclo de recuperación del journal.
 */
module.exports = function documentsService({
  messaging,
  resourceAccess,
  unitOfWork,
  ids,
  repositoriesRepository : roots,
  entriesRepository      : entries,
  favoritesRepository    : favorites,
  operationsRepository   : operations,
  settingsRepository,
  storage,
  temporaryFiles,
  utilities,
  env,
  logger,
}) {
  let isStopping     = false;
  /**
   * Ejecuta asId dentro del flujo de documents.service.
   * @param {*} value Valor de value utilizado por esta operación.
   * @param {*} [nullable] Valor de nullable utilizado por esta operación.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  const asId         = (value, nullable = false) => {
    if (nullable && (value === undefined || value === null || value === '')) return null;
    if (typeof value !== 'string' || !/^[a-fA-F0-9]{24}$/.test(value))
      throw new ApplicationError(400, 'INVALID_DOCUMENT_ID');
    return ids.parse(value);
  };
  /**
   * Evalúa la condición expresada por isSame.
   * @param {*} left Valor de left utilizado por esta operación.
   * @param {*} right Valor de right utilizado por esta operación.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  const isSame       = (left, right) => String(left ?? '') === String(right ?? '');
  /**
   * Ejecuta revision dentro del flujo de documents.service.
   * @param {*} value Valor de value utilizado por esta operación.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  const revision     = (value) => {
    if (
      (typeof value !== 'number' && typeof value !== 'string') ||
      !/^\d+$/.test(String(value)) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) < 1
    )
      throw new ApplicationError(400, 'INVALID_DOCUMENT_REVISION');
    return Number(value);
  };
  /**
   * Ejecuta documentName dentro del flujo de documents.service.
   * @param {*} value Valor de value utilizado por esta operación.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  const documentName = (value) => {
    if (typeof value !== 'string') throw new ApplicationError(400, 'INVALID_DOCUMENT_NAME');
    const name = value.normalize('NFC').trim();
    if (!name || name.length > 255 || name === '.' || name === '..' || /[/\\\p{Cc}]/u.test(name))
      throw new ApplicationError(400, 'INVALID_DOCUMENT_NAME');
    return name;
  };
  /**
   * Ejecuta context dentro del flujo de documents.service.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  function context() {
    const current = messaging.getContext();
    if (
      !current?.user?.userCode ||
      typeof current.user.userCode !== 'string' ||
      !Array.isArray(current.policies) ||
      typeof current.workspace !== 'string' ||
      !current.workspace ||
      current.workspace === 'allWorkspaces'
    )
      throw new ApplicationError(401, 'UNAUTHORIZED');
    return current;
  }
  /** Copia sólo la identidad que delimita una lectura para detectar cambios durante sus awaits.
   * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  function requestContext() {
    const current = context();
    return {
      user      : { userCode: current.user.userCode },
      workspace : current.workspace,
      policies  : [...current.policies],
      ...(current.delegation
        ? {
            delegation : { ...current.delegation },
            workspaces : [...current.workspaces],
          }
        : {}),
    };
  }
  /**
   * Ejecuta dataInput dentro del flujo de documents.service.
   * @param {Object} input Entrada que se procesa con las reglas del módulo.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  function dataInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new ApplicationError(400, 'INVALID_INPUT');
    if (
      input.accessScope !== undefined ||
      input.scope !== undefined ||
      input.context !== undefined ||
      input.storageKey !== undefined
    )
      throw new ApplicationError(400, 'INVALID_DOCUMENT_INPUT');
    return input;
  }
  /**
   * Ejecuta allowedFilter dentro del flujo de documents.service.
   * @param {*} kind Valor de kind utilizado por esta operación.
   * @param {string} action Valor de action utilizado por esta operación.
   * @param {*} [current] Valor de current utilizado por esta operación.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  function allowedFilter(kind, action, current = context()) {
    const clauses = [];
    for (const scope of KIND_SCOPES[kind]) {
      const base = {
        kind,
        erased : false,
      };
      if (action === 'create') {
        const workspace  = kind === 'workspace' ? current.workspace : 'allWorkspaces';
        const normalized = rootPolicies[kind].authorize(action, { workspace }, scope, current);
        if (!normalized) continue;
        const constraint = {
          ...base,
          workspace    : {
            $type : 'string',
            $ne   : '',
          },
          userCreate   : { $type: 'string' },
          userAssigned : { $type: 'string' },
        };
        if (scope === 'owner')
          Object.assign(constraint, {
            ownerCode  : current.user.userCode,
            userCreate : normalized.userCreate,
            workspace  : normalized.workspace,
          });
        if (scope === 'workspace')
          Object.assign(constraint, {
            workspace    : normalized.workspace,
            namespaceKey : normalized.workspace,
          });
        clauses.push(constraint);
      } else {
        const filter = rootPolicies[kind].authorize(action, base, scope, current);
        if (filter) clauses.push(filter);
      }
    }
    if (!clauses.length) return null;
    const filter = { $or: clauses };
    if (!current.delegation) return filter;
    const boundary =
      kind === 'workspace'
        ? {
            workspace    : current.workspace,
            namespaceKey : current.workspace,
          }
        : kind === 'personal'
          ? {
              ownerCode    : current.user.userCode,
              namespaceKey : current.user.userCode,
            }
          : {
              kind         : 'global',
              namespaceKey : 'global',
            };
    return { $and: [filter, boundary] };
  }
  /**
   * Ejecuta allAllowed dentro del flujo de documents.service.
   * @param {*} [actions] Valor de actions utilizado por esta operación.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  function allAllowed(actions = ['view']) {
    const filters = [];
    for (const kind of Object.keys(KIND_SCOPES))
      for (const action of actions) {
        const filter = allowedFilter(kind, action);
        if (filter) filters.push(filter);
      }
    return filters.length ? { $or: filters } : { _id: { $exists: false } };
  }
  /**
   * Ejecuta rootNamespace dentro del flujo de documents.service.
   * @param {*} kind Valor de kind utilizado por esta operación.
   * @param {*} current Valor de current utilizado por esta operación.
   * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  function rootNamespace(kind, current) {
    return {
      kind,
      namespaceKey :
        kind === 'personal'
          ? current.user.userCode
          : kind === 'workspace'
            ? current.workspace
            : 'global',
    };
  }
  /**
   * Ejecuta authorizeRoot dentro del flujo de documents.service.
   * @param {*} repositoryId Valor de repositoryId utilizado por esta operación.
   * @param {string} action Valor de action utilizado por esta operación.
   * @param {Object} session Sesión que agrupa las operaciones de persistencia.
   * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  async function authorizeRoot(repositoryId, action, session) {
    const root = await roots.getOne(
      {
        _id    : repositoryId,
        erased : false,
      },
      rootGuest,
      'view',
      undefined,
      { session },
    );
    if (root?.kind === 'resource') {
      const grant = await resourceGrant(root);
      if (!grant.capabilities[action]) throw new ApplicationError(403, 'FORBIDDEN');
      return root;
    }
    if (!root || !KIND_SCOPES[root.kind])
      throw new ApplicationError(404, 'DOCUMENT_REPOSITORY_NOT_FOUND');
    const filter = allowedFilter(root.kind, action);
    if (!filter) throw new ApplicationError(403, 'FORBIDDEN');
    const authorizedRoot = await roots.getOne(
      {
        $and : [
          {
            _id  : repositoryId,
            kind : root.kind,
          },
          filter,
        ],
      },
      rootGuest,
      'view',
      undefined,
      { session },
    );
    if (!authorizedRoot) throw new ApplicationError(403, 'FORBIDDEN');
    return authorizedRoot;
  }
  /**
   * Ejecuta defaults dentro del flujo de documents.service.
   * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  async function defaults() {
    const setting = await settingsRepository.get('documents-settings', settingsGuest);
    const data    = setting?.data;
    if (
      !data ||
      !Number.isSafeInteger(data.availableSpace) ||
      data.availableSpace <= 0 ||
      !Number.isSafeInteger(data.sizeFileMax) ||
      data.sizeFileMax <= 0 ||
      data.sizeFileMax > MAX_UPLOAD ||
      data.sizeFileMax > data.availableSpace
    )
      throw new ApplicationError(503, 'DOCUMENT_SETTINGS_INVALID');
    trashRetentionDays(data);
    return {
      availableSpace : data.availableSpace,
      sizeFileMax    : data.sizeFileMax,
    };
  }
  /**
   * Ejecuta materializeRoots dentro del flujo de documents.service.
   * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
   */
  async function materializeRoots() {
    const current = context();
    const limits  = await defaults();
    for (const kind of Object.keys(KIND_SCOPES)) {
      if (
        !ACTIONS.some(
          /**
           * Comprueba si el elemento satisface la condición.
           * @param {string} action Valor de action utilizado por esta operación.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          (action) => allowedFilter(kind, action, current),
        )
      )
        continue;
      const filter           = {
        ...rootNamespace(kind, current),
        erased : false,
      };
      const { namespaceKey } = filter;
      if (await roots.getOne(filter, rootGuest)) continue;
      const ownerCode = kind === 'personal' ? current.user.userCode : '';
      try {
        await roots.create(
          {
            ...limits,
            kind,
            namespaceKey,
            ownerCode,
            name           :
              kind === 'personal'
                ? 'Personal'
                : kind === 'workspace'
                  ? 'Espacio de trabajo'
                  : 'Global',
            workspace      : kind === 'workspace' ? current.workspace : 'allWorkspaces',
            userCreate     : ownerCode || current.user.userCode,
            userAssigned   : '',
            provisioningBy : current.user.userCode,
            idTransaction  : current.idTransaction || '',
            usedSpace      : 0,
            reservedSpace  : 0,
          },
          rootGuest,
        );
      } catch (error) {
        if (error.code !== 11000 || !(await roots.getOne(filter, rootGuest))) throw error;
      }
    }
  }
  /**
   * Ejecuta rootDto dentro del flujo de documents.service.
   * @param {Object} root Repositorio documental raíz que delimita la operación.
   * @param {*} resolvedCapabilities Valor de resolvedCapabilities utilizado por esta operación.
   * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  async function rootDto(root, resolvedCapabilities) {
    const capabilities =
      resolvedCapabilities ||
      (root.kind === 'resource' ? (await resourceGrant(root)).capabilities : {});
    for (const action of resolvedCapabilities || root.kind === 'resource' ? [] : ACTIONS) {
      const filter = allowedFilter(root.kind, action);
      capabilities[action] = !!(
        filter && (await roots.getOne({ $and: [{ _id: root._id }, filter] }, rootGuest))
      );
    }
    return {
      id             : String(root._id),
      kind           : root.kind,
      ...(root.kind === 'resource' ? { subject: resourceSubject(root.subject) } : {}),
      name           : root.name,
      ownerCode      : root.ownerCode,
      workspace      : root.workspace,
      usedSpace      : root.usedSpace,
      availableSpace : root.availableSpace,
      sizeFileMax    : root.sizeFileMax,
      revision       : root.revision,
      capabilities,
    };
  }
  /**
   * Ejecuta entryDto dentro del flujo de documents.service.
   * @param {*} entry Valor de entry utilizado por esta operación.
   * @param {Object} root Repositorio documental raíz que delimita la operación.
   * @param {*} [includeRoot] Valor de includeRoot utilizado por esta operación.
   * @param {*} projection Valor de projection utilizado por esta operación.
   * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  async function entryDto(entry, root, includeRoot = false, projection) {
    const actor      = context().user.userCode;
    const isFavorite = projection
      ? projection.favorites.has(String(entry._id))
      : !!(await favorites.getOne(
          {
            userCreate : actor,
            entryId    : entry._id,
            erased     : false,
          },
          favoriteGuest,
        ));
    const itemsCount = projection
      ? projection.children.get(`${entry.repositoryId}:${entry._id}`) || 0
      : entry.type === 'folder'
        ? await entries.count(
            {
              repositoryId : entry.repositoryId,
              parentId     : entry._id,
              state        : entry.state === 'trashed' ? 'trashed' : 'active',
              ...(entry.state === 'trashed' ? { trashRootId: entry.trashRootId } : {}),
              erased       : false,
            },
            entryGuest,
          )
        : 0;
    const item       = {
      id           : String(entry._id),
      repositoryId : String(entry.repositoryId),
      parentId     : entry.parentId ? String(entry.parentId) : null,
      name         : entry.name,
      type         : entry.type,
      size         : entry.size,
      mimeType     : entry.mimeType,
      modified     : entry.updateDate,
      creationDate : entry.creationDate,
      revision     : entry.revision,
      sha256       : entry.sha256 || null,
      itemsCount,
      isFavorite,
      ...(entry.state === 'trashed'
        ? {
            trashedAt  : entry.trashedAt,
            purgeAfter : entry.purgeAfter,
          }
        : {}),
    };
    if (includeRoot)
      item.repository = projection ? projection.roots.get(String(root._id)) : await rootDto(root);
    return item;
  }
  /** Identidad y permisos no se comparten entre peticiones ni sobreviven a una revocación.
   * @param {*} current Valor de current utilizado por esta operación.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  function contextKey(current) {
    return JSON.stringify([current.user.userCode, current.workspace, current.policies]);
  }
  /**
   * Ejecuta rootProjection dentro del flujo de documents.service.
   * @param {*} rootItems Valor de rootItems utilizado por esta operación.
   * @param {*} initial Valor de initial utilizado por esta operación.
   * @param {*} [requireView] Valor de requireView utilizado por esta operación.
   * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  async function rootProjection(rootItems, initial, requireView = false) {
    const current = context();
    if (contextKey(current) !== contextKey(initial)) throw new ApplicationError(403, 'FORBIDDEN');
    const result = new Map();
    for (let offset = 0; offset < rootItems.length; offset += 100) {
      const batch    = rootItems.slice(offset, offset + 100);
      const filters  = Object.fromEntries(
        ACTIONS.map(
          /**
           * Proyecta cada elemento en la estructura requerida por la operación.
           * @param {string} action Valor de action utilizado por esta operación.
           * @returns {Array<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          (action) => {
            const allowed = Object.keys(KIND_SCOPES)
              .map(
                /**
                 * Proyecta cada elemento en la estructura requerida por la operación.
                 * @param {*} kind Valor de kind utilizado por esta operación.
                 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                 */
                (kind) => allowedFilter(kind, action, current),
              )
              .filter(Boolean);
            return [action, allowed.length ? { $or: allowed } : null];
          },
        ),
      );
      const matched  = await roots.capabilities(
        batch.map(
          /**
           * Proyecta cada elemento en la estructura requerida por la operación.
           * @param {Object} root Repositorio documental raíz que delimita la operación.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          (root) => root._id,
        ),
        filters,
        rootGuest,
      );
      const byAction = Object.fromEntries(
        ACTIONS.map(
          /**
           * Proyecta cada elemento en la estructura requerida por la operación.
           * @param {string} action Valor de action utilizado por esta operación.
           * @returns {Array<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          (action) => [
            action,
            new Set(
              (matched[action] || []).map(
                /**
                 * Proyecta cada elemento en la estructura requerida por la operación.
                 * @param {Object} root Repositorio documental raíz que delimita la operación.
                 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                 */
                (root) => String(root._id),
              ),
            ),
          ],
        ),
      );
      for (const root of batch) {
        const capabilities =
          root.kind === 'resource'
            ? (await resourceGrant(root)).capabilities
            : Object.fromEntries(
                ACTIONS.map(
                  /**
                   * Proyecta cada elemento en la estructura requerida por la operación.
                   * @param {string} action Valor de action utilizado por esta operación.
                   * @returns {Array<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                   */
                  (action) => [action, byAction[action].has(String(root._id))],
                ),
              );
        if (requireView && !capabilities.view) throw new ApplicationError(403, 'FORBIDDEN');
        result.set(String(root._id), await rootDto(root, capabilities));
      }
    }
    if (contextKey(context()) !== contextKey(initial)) throw new ApplicationError(403, 'FORBIDDEN');
    return result;
  }
  /**
   * Ejecuta pageProjection dentro del flujo de documents.service.
   * @param {Array<*>} items Elementos que se recorren o transforman.
   * @param {*} rootItems Valor de rootItems utilizado por esta operación.
   * @param {*} current Valor de current utilizado por esta operación.
   * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  async function pageProjection(items, rootItems, current) {
    const projection = {
      favorites : new Set(),
      children  : new Map(),
    };
    const unique     = [
      ...new Map(
        items.map(
          /**
           * Proyecta cada elemento en la estructura requerida por la operación.
           * @param {*} item Valor de item utilizado por esta operación.
           * @returns {Array<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          (item) => [String(item._id), item],
        ),
      ).values(),
    ];
    for (let offset = 0; offset < unique.length; offset += 100) {
      const batch        = unique.slice(offset, offset + 100);
      const favoriteRows = await favorites.forEntries(
        current.user.userCode,
        batch.map(
          /**
           * Proyecta cada elemento en la estructura requerida por la operación.
           * @param {*} item Valor de item utilizado por esta operación.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          (item) => item._id,
        ),
        favoriteGuest,
      );
      const counts       = await entries.countByParents(
        batch.filter(
          /**
           * Determina si el elemento cumple el criterio de selección.
           * @param {*} item Valor de item utilizado por esta operación.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          (item) => item.type === 'folder',
        ),
        entryGuest,
      );
      for (const item of favoriteRows) projection.favorites.add(String(item.entryId));
      for (const item of counts)
        projection.children.set(`${item._id.repositoryId}:${item._id.parentId}`, item.count);
    }
    // Esta consulta final conserva las restricciones de cada raíz después del resto de lecturas.
    projection.roots = await rootProjection(rootItems, current, true);
    return projection;
  }
  /**
   * Ejecuta breadcrumbs dentro del flujo de documents.service.
   * @param {Object} root Repositorio documental raíz que delimita la operación.
   * @param {*} parentId Valor de parentId utilizado por esta operación.
   * @param {Object} session Sesión que agrupa las operaciones de persistencia.
   * @returns {Promise<Array<*>>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  async function breadcrumbs(root, parentId, session) {
    const list    = [];
    const visited = new Set();
    let current   = parentId;
    while (current) {
      if (visited.has(String(current))) throw new ApplicationError(409, 'DOCUMENT_TREE_INVALID');
      visited.add(String(current));
      const folder = await entries.getOne(
        {
          _id          : current,
          repositoryId : root._id,
          type         : 'folder',
          state        : 'active',
          erased       : false,
        },
        entryGuest,
        'view',
        undefined,
        { session },
      );
      if (!folder) throw new ApplicationError(404, 'DOCUMENT_FOLDER_NOT_FOUND');
      list.unshift({
        id   : String(folder._id),
        name : folder.name,
      });
      current = folder.parentId;
    }
    return [
      {
        id   : null,
        name : root.name,
      },
      ...list,
    ];
  }
  /**
   * Ejecuta requireParent dentro del flujo de documents.service.
   * @param {Object} root Repositorio documental raíz que delimita la operación.
   * @param {*} parentId Valor de parentId utilizado por esta operación.
   * @param {Object} session Sesión que agrupa las operaciones de persistencia.
   * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  async function requireParent(root, parentId, session) {
    if (!parentId) return null;
    const item = await entries.getOne(
      {
        _id          : parentId,
        repositoryId : root._id,
        type         : 'folder',
        state        : 'active',
        erased       : false,
      },
      entryGuest,
      'view',
      undefined,
      { session },
    );
    if (!item) throw new ApplicationError(404, 'DOCUMENT_FOLDER_NOT_FOUND');
    return item;
  }
  /**
   * Ejecuta locateEntry dentro del flujo de documents.service.
   * @param {*} entryId Valor de entryId utilizado por esta operación.
   * @param {string} action Valor de action utilizado por esta operación.
   * @param {Object} session Sesión que agrupa las operaciones de persistencia.
   * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  async function locateEntry(entryId, action, session) {
    const repositoryId = await entries.resolveRepositoryId(entryId, entryGuest, { session });
    if (!repositoryId) throw new ApplicationError(404, 'DOCUMENT_NOT_FOUND');
    const root  = await authorizeRoot(repositoryId, action, session);
    const entry = await entries.getOne(
      {
        _id          : entryId,
        repositoryId : root._id,
        state        : 'active',
        erased       : false,
      },
      entryGuest,
      'view',
      undefined,
      { session },
    );
    if (!entry) throw new ApplicationError(409, 'DOCUMENT_REVISION_CONFLICT');
    return {
      entry,
      root,
    };
  }
  /**
   * Ejecuta locateTrashEntry dentro del flujo de documents.service.
   * @param {*} entryId Valor de entryId utilizado por esta operación.
   * @param {string} action Valor de action utilizado por esta operación.
   * @param {Object} session Sesión que agrupa las operaciones de persistencia.
   * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  async function locateTrashEntry(entryId, action, session) {
    const repositoryId = await entries.resolveRepositoryId(entryId, entryGuest, {
      session,
      state : 'trashed',
    });
    if (!repositoryId) throw new ApplicationError(404, 'DOCUMENT_NOT_FOUND');
    const root  = await authorizeRoot(repositoryId, action, session);
    const entry = await entries.getOne(
      {
        _id         : entryId,
        repositoryId,
        state       : 'trashed',
        trashRootId : entryId,
        erased      : false,
      },
      entryGuest,
      'view',
      undefined,
      { session },
    );
    if (!entry) throw new ApplicationError(404, 'DOCUMENT_NOT_FOUND');
    return {
      entry,
      root,
    };
  }
  /**
   * Ejecuta lockRoots dentro del flujo de documents.service.
   * @param {*} repositoryIds Valor de repositoryIds utilizado por esta operación.
   * @param {Object} session Sesión que agrupa las operaciones de persistencia.
   * @param {Object} expected Revisiones opcionales por repositorio antes del bloqueo.
   * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
   */
  async function lockRoots(repositoryIds, session, expected = {}) {
    for (const repositoryId of [...new Set(repositoryIds.map(String))].sort()) {
      const root = await roots.update(
        {
          _id    : ids.parse(repositoryId),
          erased : false,
          ...(expected[repositoryId] !== undefined ? { revision: expected[repositoryId] } : {}),
        },
        {
          $inc : { revision: 1 },
          $set : { updateDate: Date.now() },
        },
        rootGuest,
        { session },
      );
      if (!root)
        throw new ApplicationError(
          expected[repositoryId] !== undefined ? 409 : 404,
          expected[repositoryId] !== undefined
            ? 'DOCUMENT_REPOSITORY_REVISION_CONFLICT'
            : 'DOCUMENT_REPOSITORY_NOT_FOUND',
        );
    }
  }
  /**
   * Ejecuta subtree dentro del flujo de documents.service.
   * @param {Object} root Repositorio documental raíz que delimita la operación.
   * @param {*} entry Valor de entry utilizado por esta operación.
   * @param {Object} session Sesión que agrupa las operaciones de persistencia.
   * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  async function subtree(root, entry, session) {
    const result = [entry];
    for (let cursor = 0; cursor < result.length; cursor++) {
      if (result[cursor].type !== 'folder') continue;
      const children = await readAll(
        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @param {number} page Índice de la página según el contrato de esta operación.
         * @param {number} perPage Cantidad máxima de elementos por página.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        (page, perPage) =>
          entries.getList(
            {
              repositoryId : root._id,
              parentId     : result[cursor]._id,
              state        : { $ne: 'trashed' },
              erased       : false,
            },
            {
              ...{},
              _id : 1,
            },
            page,
            perPage,
            '',
            entryGuest,
            { session },
          ),
      );
      result.push(...children.listItem);
    }
    if (
      result.some(
        /**
         * Comprueba si el elemento satisface la condición.
         * @param {*} item Valor de item utilizado por esta operación.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        (item) => item.state !== 'active' || item.pendingOperation,
      )
    )
      throw new ApplicationError(409, 'DOCUMENT_OPERATION_PENDING');
    return result;
  }
  /** @param {Object} input Precondición opcional del cliente. @param {Object[]} nodes Subárbol autorizado leído bajo bloqueo de raíz. @returns {void} Impide actuar sobre hijos nuevos o revisiones que el cliente aún no conoce. */
  function checkSubtreeRevision(input, nodes) {
    if (input.expectedSubtreeHash === undefined) return;
    const values = nodes
      .map(
        /** @param {Object} node Entrada autorizada. @returns {Array} Identidad y revisión de negocio; excluye reservas privadas. */
        (node) => [String(node._id), node.revision],
      )
      .sort(
        /** @param {Array} left Primera identidad. @param {Array} right Segunda identidad. @returns {number} Orden binario independiente del idioma. */
        (left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0),
      );
    if (unitOfWork.hash(values) !== input.expectedSubtreeHash)
      throw new ApplicationError(409, 'DOCUMENT_SUBTREE_REVISION_CONFLICT');
  }
  /**
   * Ejecuta collision dentro del flujo de documents.service.
   * @param {Object} root Repositorio documental raíz que delimita la operación.
   * @param {*} parentId Valor de parentId utilizado por esta operación.
   * @param {string} name Nombre del componente o recurso.
   * @param {*} excludeId Valor de excludeId utilizado por esta operación.
   * @param {Object} session Sesión que agrupa las operaciones de persistencia.
   * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  async function collision(root, parentId, name, excludeId, session) {
    const filter = {
      repositoryId : root._id,
      parentId,
      nameKey      : name,
      state        : { $ne: 'trashed' },
      erased       : false,
    };
    if (excludeId) filter._id = { $ne: excludeId };
    return entries.getOne(filter, entryGuest, 'view', undefined, { session });
  }
  /**
   * Ejecuta listOptions dentro del flujo de documents.service.
   * @param {Object} input Entrada que se procesa con las reglas del módulo.
   * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  function listOptions(input) {
    if (input.search !== undefined && typeof input.search !== 'string')
      throw new ApplicationError(400, 'INVALID_DOCUMENT_SEARCH');
    const type  = input.type ?? '';
    const sort  = input.sort ?? 'name';
    const order = input.order ?? 'asc';
    if (
      !['', 'file', 'folder'].includes(type) ||
      !['name', 'type', 'size', 'modified'].includes(sort) ||
      !['asc', 'desc'].includes(order)
    )
      throw new ApplicationError(400, 'INVALID_DOCUMENT_FILTER');
    const filter = {
      state  : 'active',
      erased : false,
    };
    if (type) filter.type = type;
    if (input.search)
      filter.name = {
        $regex   : utilities.escapeRegex(input.search.normalize('NFC')),
        $options : 'i',
      };
    const sortFields = {
      [sort === 'modified' ? 'updateDate' : sort] : order === 'asc' ? 1 : -1,
      _id                                         : 1,
    };
    return {
      filter,
      sort : sortFields,
      ...utilities.getPublicPagination(input),
    };
  }
  /**
   * Ejecuta transaction dentro del flujo de documents.service.
   * @param {Function} callback Operación que se invoca durante el procesamiento.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  const transaction = (callback) => unitOfWork.run(callback);
  /**
   * Ejecuta metadata dentro del flujo de documents.service.
   * @param {Object} root Repositorio documental raíz que delimita la operación.
   * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  function metadata(root) {
    const current = context();
    return {
      workspace     : root.workspace,
      userCreate    : current.user.userCode,
      userAssigned  : '',
      idTransaction : current.idTransaction || '',
    };
  }
  /** Publica invalidación durable sin contenido ni autoridad heredada del solicitante.
   * @param {*} entry Valor de entry utilizado por esta operación.
   * @param {*} operation Valor de operation utilizado por esta operación.
   * @param {Object} session Sesión que agrupa las operaciones de persistencia.
   * @param {*} [changeCode] Valor de changeCode utilizado por esta operación.
   * @param {*} [previous] Valor de previous utilizado por esta operación.
   * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
   */
  async function entryChanged(entry, operation, session, changeCode = '', previous = {}) {
    const publicationId = `document:${entry._id}:${entry.revision}:${operation}:${changeCode}`;
    const root          = await roots.getOne({ _id: entry.repositoryId }, rootGuest, 'view', undefined, {
      session,
    });
    const previousRoot  =
      previous.previousRepositoryId && String(entry.repositoryId) !== previous.previousRepositoryId
        ? await roots.getOne(
            { _id: ids.parse(previous.previousRepositoryId) },
            rootGuest,
            'view',
            undefined,
            { session },
          )
        : root;
    await messaging.publishEvent(
      'documents.entry.changed',
      {
        entryId            : String(entry._id),
        repositoryId       : String(entry.repositoryId),
        parentId           : entry.parentId ? String(entry.parentId) : null,
        revision           : entry.revision,
        repositoryRevision : root.revision,
        ...(previous.previousRepositoryId
          ? { previousRepositoryRevision: previousRoot.revision }
          : {}),
        workspace          : entry.workspace,
        operation,
        changeCode         : publicationId,
        ...previous,
      },
      {
        session,
        context : {},
        publicationId,
      },
    );
  }
  /**
   * Ejecuta preflight dentro del flujo de documents.service.
   * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
   */
  async function preflight() {
    if (!env.BUCKET_DOCUMENTS || !/^[a-zA-Z0-9_-]+$/.test(env.ENV_NAME || ''))
      throw new ApplicationError(503, 'DOCUMENT_STORAGE_CONFIGURATION_REQUIRED');
    await defaults();
    await unitOfWork.verify();
    for (const repository of [roots, entries, favorites, operations])
      await repository.checkIndexes();
  }
  /**
   * Ejecuta cleanupOperation dentro del flujo de documents.service.
   * @param {*} operation Valor de operation utilizado por esta operación.
   * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
   */
  async function cleanupOperation(operation) {
    for (const key of operation.keys) await storage.delete(key);
    // Una respuesta PUT perdida puede materializarse después del primer DELETE.
    // Conservamos esas claves opacas y volvemos a borrarlas; no se reutilizan ni se descubren en S3.
    const changes =
      operation.state === 'abandoned'
        ? {
            leaseUntil : Date.now() + ABANDONED_RECHECK_MS,
            updateDate : Date.now(),
          }
        : {
            state      : 'complete',
            keys       : [],
            leaseUntil : 0,
            updateDate : Date.now(),
          };
    await operations.update(
      {
        _id        : operation._id,
        state      : operation.state,
        leaseToken : operation.leaseToken,
      },
      { $set: changes },
      operationGuest,
    );
    if (operation.tempFilePath) await temporaryFiles.remove(operation.tempFilePath);
  }
  /**
   * Ejecuta finishUpload dentro del flujo de documents.service.
   * @param {*} operation Valor de operation utilizado por esta operación.
   * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  async function finishUpload(operation) {
    if (!operation.delegation) {
      const root = await roots.getOne({ _id: operation.repositoryId }, rootGuest);
      if (root?.kind !== 'resource') return finishUploadAuthorized(operation);
      try {
        if (root.resourceDeletedAt) throw new ApplicationError(403, 'FORBIDDEN');
        const actor = {
          user      : { userCode: operation.userCreate },
          workspace : operation.executionWorkspace,
          policies  : [],
        };
        if (['ticket', 'ticket-internal'].includes(root.subject?.domain)) {
          const response = await messaging.request(
            'service-security',
            'workspace-principals-get-list',
            {
              workspace : operation.executionWorkspace,
              userCodes : [operation.userCreate],
            },
          );
          if ([401, 403, 404].includes(response?.statusCode))
            throw new ApplicationError(403, 'FORBIDDEN');
          if (response?.statusCode !== 200 || !Array.isArray(response.data?.items))
            throw new ApplicationError(503, 'DOCUMENT_IDENTITY_UNAVAILABLE');
          const principal = response.data.items.find(
            /** @param {Object} entry Principal vigente. @returns {boolean} Autor y espacio originales. */
            (entry) =>
              entry.userCode === operation.userCreate &&
              entry.workspace === operation.executionWorkspace,
          );
          if (!principal) throw new ApplicationError(403, 'FORBIDDEN');
          actor.policies = principal.policies;
        }
        return await messaging.runWithContext(
          actor,
          /** @returns {Promise<Object|null>} Confirma bajo el acceso actual del autor. */
          () => finishUploadAuthorized(operation),
        );
      } catch (error) {
        if (![401, 403, 404].includes(error.statusCode)) throw error;
        await abortUpload(operation);
        return null;
      }
    }
    const actor = await delegatedUploadActor(operation);
    if (!actor) {
      await abortUpload(operation);
      return null;
    }
    try {
      return await messaging.runWithContext(
        actor,
        /** @returns {Promise<Object|null>} Commit bajo permisos actuales. */ () =>
          finishUploadAuthorized(operation),
      );
    } catch (error) {
      if (![401, 403, 404].includes(error.statusCode)) throw error;
      await abortUpload(operation);
      return null;
    }
  }
  /** @param {Object} operation Intención aceptada. @returns {Promise<Object|null>} Principal vigente; ausencia significa revocación. */
  async function delegatedUploadActor(operation) {
    const response = await messaging.request('service-security', 'oauth-principal-resolve', {
      ...operation.delegation,
      workspace : operation.executionWorkspace,
    });
    if ([401, 403, 404].includes(response?.statusCode)) return null;
    if (response?.statusCode !== 200)
      throw new ApplicationError(503, 'DOCUMENT_IDENTITY_UNAVAILABLE');
    const principal = response.data;
    if (
      principal.userCode !== operation.userCreate ||
      !principal.scopes.includes('documents:upload')
    )
      return null;
    return {
      user       : { userCode: principal.userCode },
      workspace  : principal.workspace,
      workspaces : principal.workspaces,
      policies   : principal.policies,
      delegation : operation.delegation,
    };
  }
  /** @param {Object} entry Archivo confirmado. @param {string} userCode Autor del intento. @param {Object} session Transacción. @returns {Promise<Object>} Resultado público persistido junto con la versión. */
  async function uploadResult(entry, userCode, session) {
    return {
      id           : String(entry._id),
      repositoryId : String(entry.repositoryId),
      parentId     : entry.parentId ? String(entry.parentId) : null,
      name         : entry.name,
      type         : entry.type,
      size         : entry.size,
      mimeType     : entry.mimeType,
      modified     : entry.updateDate,
      creationDate : entry.creationDate,
      revision     : entry.revision,
      itemsCount   : 0,
      sha256       : entry.sha256 || null,
      isFavorite   : !!(await favorites.getOne(
        {
          userCreate : userCode,
          entryId    : entry._id,
          erased     : false,
        },
        favoriteGuest,
        'view',
        undefined,
        { session },
      )),
    };
  }
  /** @param {Object} operation Intención acreditada. @returns {Promise<Object|null>} Finaliza reserva y recibo en la misma transacción. */
  async function finishUploadAuthorized(operation) {
    return transaction(
      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @param {Object} session Sesión que agrupa las operaciones de persistencia.
       * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      async (session) => {
        const current = await operations.getOne(
          {
            _id   : operation._id,
            state : 'pending',
          },
          operationGuest,
          'view',
          undefined,
          { session },
        );
        if (!current) return null;
        await lockRoots([current.repositoryId], session);
        const currentRoot = await roots.getOne(
          { _id: current.repositoryId },
          rootGuest,
          'view',
          undefined,
          { session },
        );
        if (current.delegation || currentRoot?.kind === 'resource')
          await authorizeRoot(
            current.repositoryId,
            current.isNewEntry ? 'create' : 'update',
            session,
          );
        const root  = await roots.getOne(
          { _id: current.repositoryId },
          rootGuest,
          'view',
          undefined,
          {
            session,
          },
        );
        const entry = await entries.getOne(
          {
            _id              : current.entryId,
            repositoryId     : current.repositoryId,
            pendingOperation : current._id,
            revision         : current.expectedRevision,
          },
          entryGuest,
          'view',
          undefined,
          { session },
        );
        if (!entry) throw new ApplicationError(409, 'DOCUMENT_REVISION_CONFLICT');
        const now  = Date.now();
        const item = await entries.update(
          {
            _id              : entry._id,
            repositoryId     : root._id,
            pendingOperation : current._id,
            revision         : current.expectedRevision,
          },
          {
            $set : {
              storageKey       : current.storageKey,
              sha256           : current.checksum,
              size             : current.size,
              mimeType         : current.mimeType,
              state            : 'active',
              pendingOperation : null,
              updateDate       : now,
            },
            $inc : { revision: current.isNewEntry ? 0 : 1 },
          },
          entryGuest,
          { session },
        );
        await roots.update(
          { _id: root._id },
          {
            $inc : {
              usedSpace     : current.size - current.oldSize,
              reservedSpace : -current.reservedSpace,
            },
          },
          rootGuest,
          { session },
        );
        await operations.update(
          {
            _id   : current._id,
            state : 'pending',
          },
          {
            $set : {
              ...(current.requestKey
                ? { result: await uploadResult(item, current.userCreate, session) }
                : {}),
              state      : current.oldStorageKey ? 'cleanup' : 'complete',
              keys       : current.oldStorageKey ? [current.oldStorageKey] : [],
              leaseUntil : 0,
              updateDate : now,
            },
          },
          operationGuest,
          { session },
        );
        await entryChanged(item, current.isNewEntry ? 'upload' : 'replace', session);
        return item;
      },
    );
  }
  /**
   * Ejecuta abortUpload dentro del flujo de documents.service.
   * @param {*} operation Valor de operation utilizado por esta operación.
   * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
   */
  async function abortUpload(operation) {
    await transaction(
      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @param {Object} session Sesión que agrupa las operaciones de persistencia.
       * @returns {Promise<undefined>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      async (session) => {
        const current = await operations.getOne(
          {
            _id   : operation._id,
            state : 'pending',
          },
          operationGuest,
          'view',
          undefined,
          { session },
        );
        if (!current) return;
        await lockRoots([current.repositoryId], session);
        const filter = {
          _id              : current.entryId,
          repositoryId     : current.repositoryId,
          pendingOperation : current._id,
        };
        if (current.isNewEntry) await entries.deleteOne(filter, false, entryGuest, { session });
        else
          await entries.update(filter, { $set: { pendingOperation: null } }, entryGuest, {
            session,
          });
        await roots.update(
          { _id: current.repositoryId },
          { $inc: { reservedSpace: -current.reservedSpace } },
          rootGuest,
          { session },
        );
        await operations.update(
          { _id: current._id },
          {
            $set : {
              state      : 'abandoned',
              keys       : [current.storageKey],
              leaseUntil : 0,
              updateDate : Date.now(),
            },
          },
          operationGuest,
          { session },
        );
      },
    );
  }
  /** Reclama cada subárbol vencido bajo el mismo bloqueo transaccional que restaurar.
   * @param {Function} shouldStop Continuidad y cierre del trabajador.
   * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
   */
  async function purgeExpired(shouldStop) {
    const expired = await entries.getList(
      {
        state      : 'trashed',
        purgeAfter : {
          $gt  : 0,
          $lte : Date.now(),
        },
        $expr      : { $eq: ['$_id', '$trashRootId'] },
      },
      {
        purgeAfter : 1,
        _id        : 1,
      },
      0,
      50,
      '',
      entryGuest,
    );
    for (const candidate of expired.listItem) {
      if (isStopping || shouldStop()) break;
      await transaction(
        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @param {Object} session Sesión que agrupa las operaciones de persistencia.
         * @returns {Promise<undefined>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        async (session) => {
          await lockRoots([candidate.repositoryId], session);
          const entry = await entries.getOne(
            {
              _id        : candidate._id,
              state      : 'trashed',
              purgeAfter : {
                $gt  : 0,
                $lte : Date.now(),
              },
            },
            entryGuest,
            'view',
            undefined,
            { session },
          );
          if (!entry) return;
          const tree = await readAll(
            /**
             * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
             * @param {number} page Índice de la página según el contrato de esta operación.
             * @param {number} perPage Cantidad máxima de elementos por página.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            (page, perPage) =>
              entries.getList(
                {
                  repositoryId : entry.repositoryId,
                  state        : 'trashed',
                  trashRootId  : entry._id,
                },
                { _id: 1 },
                page,
                perPage,
                '',
                entryGuest,
                { session },
              ),
          );
          const keys = tree.listItem
            .filter(
              /**
               * Determina si el elemento cumple el criterio de selección.
               * @param {*} node Valor de node utilizado por esta operación.
               * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
               */
              (node) => node.type === 'file',
            )
            .map(
              /**
               * Proyecta cada elemento en la estructura requerida por la operación.
               * @param {*} node Valor de node utilizado por esta operación.
               * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
               */
              (node) => node.storageKey,
            );
          if (keys.length)
            await operations.create(
              {
                workspace    : entry.workspace,
                userCreate   : entry.userCreate,
                userAssigned : '',
                kind         : 'cleanup',
                state        : 'cleanup',
                repositoryId : entry.repositoryId,
                keys,
              },
              operationGuest,
              { session },
            );
          await entries.deleteMany(
            {
              repositoryId : entry.repositoryId,
              state        : 'trashed',
              trashRootId  : entry._id,
            },
            false,
            entryGuest,
            { session },
          );
          await roots.update(
            { _id: entry.repositoryId },
            {
              $inc : {
                usedSpace : -tree.listItem.reduce(
                  /**
                   * Acumula el resultado de los elementos recorridos.
                   * @param {*} sum Valor de sum utilizado por esta operación.
                   * @param {*} node Valor de node utilizado por esta operación.
                   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                   */
                  (sum, node) => sum + node.size,
                  0,
                ),
              },
            },
            rootGuest,
            { session },
          );
          for (const node of tree.listItem) await entryChanged(node, 'delete', session);
        },
      );
    }
  }
  /**
   * Ejecuta recoverOnce dentro del flujo de documents.service.
   * @param {Object} options Continuidad y cierre cooperativo del lote.
   * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
   */
  async function recoverOnce(options = {}) {
    /** @returns {boolean} Detiene el lote entre efectos al cerrar o perder continuidad. */
    const shouldStop = () => isStopping || options.shouldStop?.() === true;
    await cleanupInactiveResources(shouldStop);
    if (shouldStop()) return;
    await purgeExpired(shouldStop);
    if (shouldStop()) return;
    const pending = await operations.getList(
      {
        state      : { $in: ['pending', 'cleanup', 'abandoned'] },
        leaseUntil : { $lte: Date.now() },
      },
      { creationDate: 1 },
      0,
      50,
      '',
      operationGuest,
    );
    for (const candidate of pending.listItem) {
      if (isStopping || shouldStop()) break;
      const leaseToken = randomUUID();
      const operation  = await operations.update(
        {
          _id        : candidate._id,
          state      : candidate.state,
          leaseUntil : { $lte: Date.now() },
        },
        {
          $set : {
            leaseUntil : Date.now() + LEASE_MS,
            leaseToken,
          },
        },
        operationGuest,
      );
      if (!operation) continue;
      try {
        if (operation.state === 'pending') {
          const head = await storage.head(operation.storageKey);
          if (
            head &&
            head.size === operation.size &&
            head.checksum === operation.checksum &&
            head.operation === String(operation._id)
          )
            await finishUpload(operation);
          else if (operation.settleUntil > Date.now()) {
            await operations.update(
              {
                _id   : operation._id,
                state : 'pending',
                leaseToken,
              },
              { $set: { leaseUntil: operation.settleUntil } },
              operationGuest,
            );
            continue;
          } else await abortUpload(operation);
        }
        const cleanup = await operations.getOne(
          {
            _id   : operation._id,
            state : { $in: ['cleanup', 'abandoned'] },
          },
          operationGuest,
        );
        if (cleanup) await cleanupOperation(cleanup);
        if (operation.tempFilePath) await temporaryFiles.remove(operation.tempFilePath);
      } catch {
        logger?.error?.({
          component : 'documents',
          event     : 'recovery_deferred',
          code      : 'DOCUMENT_RECOVERY_PENDING',
        });
        await operations
          .update(
            {
              _id : operation._id,
              leaseToken,
            },
            { $set: { leaseUntil: Date.now() + 10000 } },
            operationGuest,
          )
          .catch(
            /**
             * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
             * @returns {void} Finaliza después de aplicar los efectos de la operación.
             */
            () => {},
          );
      }
    }
  }
  /** @param {Object} root Raíz de recurso. @returns {Promise<Object>} Acceso vigente acreditado por el propietario. */
  async function resourceGrant(root) {
    if (root.resourceDeletedAt || root.erased) throw new ApplicationError(403, 'FORBIDDEN');
    if (typeof resourceAccess !== 'function')
      throw new ApplicationError(503, 'DOCUMENT_RESOURCE_ACCESS_UNAVAILABLE');
    const grant = await resourceAccess(resourceSubject(root.subject), requestContext());
    if (grant.workspace !== root.workspace) throw new ApplicationError(403, 'FORBIDDEN');
    return grant;
  }
  /** @param {Object} subject Referencia canónica. @param {string} workspace Alcance del propietario. @param {Object} actor Autor técnico. @returns {Promise<Object>} Raíz única, incluso si fue retirada concurrentemente. */
  async function materializeResource(subject, workspace, actor) {
    const filter   = {
      kind         : 'resource',
      namespaceKey : resourceNamespace(subject),
    };
    const existing = await roots.getOne(filter, rootGuest);
    if (existing) return existing;
    try {
      return await roots.create(
        {
          ...(await defaults()),
          ...filter,
          subject,
          workspace,
          name           :
            subject.service === 'service-support' ? 'Archivos del ticket' : 'Archivos de la tarea',
          ownerCode      : '',
          userCreate     : actor.user.userCode,
          userAssigned   : '',
          provisioningBy : actor.user.userCode,
          idTransaction  : actor.idTransaction || '',
          usedSpace      : 0,
          reservedSpace  : 0,
        },
        rootGuest,
      );
    } catch (error) {
      const concurrent = await roots.getOne(filter, rootGuest);
      if (!concurrent) throw error;
      return concurrent;
    }
  }
  /** @param {Object} root Raíz inactiva. @returns {Promise<void>} Retira cargas y archivos sin renovar fechas previas de papelera. */
  async function trashResource(root) {
    const pending = await readAll(
      /** @param {number} page Página. @param {number} perPage Tamaño. @returns {Promise<Object>} Cargas pendientes. */
      (page, perPage) =>
        operations.getList(
          {
            repositoryId : root._id,
            kind         : 'upload',
            state        : 'pending',
          },
          { _id: 1 },
          page,
          perPage,
          '',
          operationGuest,
        ),
    );
    for (const operation of pending.listItem) await abortUpload(operation);
    const purgeAfter = root.resourcePurgeAfter;
    for (;;) {
      const page = await entries.getList(
        {
          repositoryId : root._id,
          state        : 'active',
          erased       : false,
        },
        { _id: 1 },
        0,
        50,
        '',
        entryGuest,
      );
      if (!page.listItem.length) break;
      await transaction(
        /** @param {Object} session Transacción. @returns {Promise<void>} Papelera y avisos atómicos. */
        async (session) => {
          await lockRoots([root._id], session);
          await favorites.deleteMany(
            {
              entryId : {
                $in : page.listItem.map(
                  /** @param {Object} item Entrada retirada. @returns {*} Identidad documental. */
                  (item) => item._id,
                ),
              },
            },
            false,
            favoriteGuest,
            { session },
          );
          for (const item of page.listItem) {
            const changed = await entries.update(
              {
                _id   : item._id,
                state : 'active',
              },
              {
                $set : {
                  state       : 'trashed',
                  trashRootId : item._id,
                  trashedAt   : root.resourceDeletedAt,
                  purgeAfter,
                  updateDate  : root.resourceDeletedAt,
                },
                $inc : { revision: 1 },
              },
              entryGuest,
              { session },
            );
            if (changed) await entryChanged(changed, 'trash', session);
          }
        },
      );
    }
    await roots.update({ _id: root._id }, { $set: { resourceCleanupPending: false } }, rootGuest);
  }
  /** @param {Function} shouldStop Continuidad y cierre. @returns {Promise<void>} Retoma bajas interrumpidas conservadas antes de confirmar el evento. */
  async function cleanupInactiveResources(shouldStop) {
    const pending = await roots.getList(
      {
        kind                   : 'resource',
        resourceCleanupPending : true,
      },
      { _id: 1 },
      0,
      50,
      '',
      rootGuest,
    );
    for (const root of pending.listItem) {
      if (isStopping || shouldStop()) break;
      await trashResource(root);
    }
  }
  return {
    /** @param {Object} input Referencia estable del recurso. @returns {Promise<Object>} Repositorio exclusivo con acceso revalidado. */
    async resolveRepository(input) {
      dataInput(input);
      const subject = resourceSubject(input.subject);
      const actor   = requestContext();
      if (typeof resourceAccess !== 'function')
        throw new ApplicationError(503, 'DOCUMENT_RESOURCE_ACCESS_UNAVAILABLE');
      const grant = await resourceAccess(subject, actor);
      if (!grant.capabilities.view) throw new ApplicationError(403, 'FORBIDDEN');
      const root = await materializeResource(subject, grant.workspace, actor);
      return transaction(
        /** @returns {Promise<Object>} Revalida la raíz y sus permisos desde el estado confirmado. */
        async () => ({ repository: await rootDto(await authorizeRoot(root._id, 'view')) }),
      );
    },
    /** @param {Object} data Aviso durable del propietario. @returns {Promise<void>} Baja lógica recuperable e idempotente. */
    async resourceChanged(data) {
      if (data.resource !== 'work-item' || !data.erased) return;
      const subject            = {
        service : 'service-projects',
        domain  : 'work-item',
        code    : data.code,
      };
      const root               = await materializeResource(subject, data.workspace, {
        user : { userCode: data.userCreate },
      });
      const now                = Date.now();
      const settings           = await settingsRepository.get('documents-settings', settingsGuest);
      const resourcePurgeAfter = now + trashRetentionDays(settings?.data) * 86400000;
      const marked             = await roots.update(
        {
          _id               : root._id,
          resourceDeletedAt : { $in: [0, null] },
        },
        {
          $set : {
            resourceDeletedAt      : now,
            resourcePurgeAfter,
            resourceCleanupPending : true,
          },
          $inc : { revision: 1 },
        },
        rootGuest,
      );
      const current            = marked || (await roots.getOne({ _id: root._id }, rootGuest));
      if (current.resourceCleanupPending) await trashResource(current);
    },
    /**
     * Ejecuta preflight dentro del flujo de documents.service.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async preflight() {
      return preflight();
    },
    /**
     * Inicia el componente y sus colaboradores.
     * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
     */
    async start() {
      await preflight();
      isStopping = false;
    },
    /**
     * Cierra el componente y libera sus recursos.
     * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
     */
    async close() {
      isStopping = true;
    },
    /**
     * Ejecuta recoverOnce dentro del flujo de documents.service.
     * @param {Object} options Continuidad y cierre cooperativo del lote.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async recoverOnce(options) {
      return recoverOnce(options);
    },
    /**
     * Resuelve getRepositories aplicando los filtros y colaboradores del módulo.
     * @param {Object} [input] Entrada que se procesa con las reglas del módulo.
     * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async getRepositories(input = {}) {
      dataInput(input);
      const current = requestContext();
      await materializeRoots();
      return transaction(
        /** @returns {Promise<Object>} Catálogo público coherente después de materializar raíces faltantes. */
        async () => {
          const result = await roots.getList(
            {
              $and : [
                allAllowed(ACTIONS),
                // El catálogo muestra las raíces del selector; permisos globales no amplían navegación.
                {
                  $or : Object.keys(KIND_SCOPES).map(
                    /**
                     * Proyecta cada elemento en la estructura requerida por la operación.
                     * @param {*} kind Valor de kind utilizado por esta operación.
                     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                     */
                    (kind) => rootNamespace(kind, current),
                  ),
                },
              ],
            },
            {
              kind : 1,
              name : 1,
              _id  : 1,
            },
            0,
            4,
            '',
            rootGuest,
          );
          if (result.totalCount > 3) throw new ApplicationError(409, 'REPOSITORY_CATALOG_CONFLICT');
          return {
            listItem   : [...(await rootProjection(result.listItem, current)).values()],
            totalCount : result.totalCount,
          };
        },
      );
    },
    /** @param {Object} input Repositorio, revisión conocida o cursor ligado a una revisión. @returns {Promise<Object>} Página autoritativa; una mutación concurrente invalida todo el recorrido. */
    async getManifest(input) {
      return transaction(
        /** @returns {Promise<Object>} Filas, pertenencia, agregados y revisiones desde la misma instantánea del productor. */
        async () => {
          dataInput(input);
          context();
          const repositoryId = asId(input.repositoryId);
          const root         = await authorizeRoot(repositoryId, 'view');
          let after;
          if (input.cursor) {
            const parts = input.cursor.split(':');
            if (
              parts.length !== 3 ||
              parts[0] !== String(repositoryId) ||
              !/^[0-9]+$/.test(parts[1])
            )
              throw new ApplicationError(400, 'INVALID_DOCUMENT_CURSOR');
            after = asId(parts[2]);
            if (Number(parts[1]) !== root.revision)
              throw new ApplicationError(409, 'DOCUMENT_MANIFEST_CHANGED');
          }
          const repository = await rootDto(root);
          if (!input.cursor && input.knownRevision === root.revision)
            return {
              repository,
              revision    : root.revision,
              notModified : true,
              items       : [],
              nextCursor  : null,
            };
          const page    = await entries.getList(
            {
              repositoryId,
              state  : 'active',
              erased : false,
              ...(after ? { _id: { $gt: after } } : {}),
            },
            { _id: 1 },
            0,
            501,
            '',
            entryGuest,
          );
          const checked = await authorizeRoot(repositoryId, 'view');
          if (checked.revision !== root.revision)
            throw new ApplicationError(409, 'DOCUMENT_MANIFEST_CHANGED');
          const items = page.listItem.slice(0, 500).map(
            /** @param {Object} entry Fila autorizada. @returns {Object} Metadatos públicos sin claves de almacenamiento. */
            (entry) => ({
              id           : String(entry._id),
              repositoryId : String(repositoryId),
              parentId     : entry.parentId ? String(entry.parentId) : null,
              name         : entry.name,
              type         : entry.type,
              revision     : entry.revision,
              size         : entry.size,
              mimeType     : entry.mimeType,
              modified     : entry.updateDate,
              creationDate : entry.creationDate,
              sha256       : entry.sha256 || null,
            }),
          );
          return {
            repository,
            revision    : root.revision,
            notModified : false,
            items,
            nextCursor  :
              page.listItem.length > 500
                ? `${repositoryId}:${root.revision}:${items.at(-1).id}`
                : null,
          };
        },
      );
    },
    /**
     * Consulta una página de registros autorizados.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async getList(input) {
      return transaction(
        /** @returns {Promise<Object>} Filas, pertenencia, agregados y revisiones desde la misma instantánea del productor. */
        async () => {
          dataInput(input);
          const current      = requestContext();
          const repositoryId = asId(input.repositoryId);
          const parentId     = asId(input.parentId, true);
          const root         = await authorizeRoot(repositoryId, 'view');
          const folder       = await requireParent(root, parentId);
          const options      = listOptions(input);
          const result       = await entries.getList(
            {
              ...options.filter,
              repositoryId,
              parentId,
            },
            options.sort,
            options.page,
            options.perPage,
            '',
            entryGuest,
          );
          const trail        = await breadcrumbs(root, parentId);
          const projection   = await pageProjection(
            [...result.listItem, ...(folder ? [folder] : [])],
            [root],
            current,
          );
          return {
            listItem    : await Promise.all(
              result.listItem.map(
                /**
                 * Proyecta cada elemento en la estructura requerida por la operación.
                 * @param {*} item Valor de item utilizado por esta operación.
                 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                 */
                (item) => entryDto(item, root, false, projection),
              ),
            ),
            totalCount  : result.totalCount,
            repository  : projection.roots.get(String(root._id)),
            folder      : folder ? await entryDto(folder, root, false, projection) : null,
            breadcrumbs : trail,
          };
        },
      );
    },
    /**
     * Obtiene el registro que cumple los filtros autorizados.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async getOne(input) {
      return transaction(
        /** @returns {Promise<Object>} Filas, pertenencia, agregados y revisiones desde la misma instantánea del productor. */
        async () => {
          dataInput(input);
          context();
          const { entry, root } = await (input.trash === true ? locateTrashEntry : locateEntry)(
            asId(input.entryId),
            'view',
          );
          return {
            item        : await entryDto(entry, root),
            repository  : await rootDto(root),
            breadcrumbs :
              input.trash === true
                ? [
                    {
                      id   : null,
                      name : root.name,
                    },
                  ]
                : await breadcrumbs(root, entry.parentId),
          };
        },
      );
    },
    /** @param {Object} input Identidades explícitas de referencias seleccionadas. @returns {Promise<Object>} Sólo registros autorizados en el orden de la solicitud, con snapshot común. */
    async getReferences(input) {
      dataInput(input);
      context();
      if (
        !Array.isArray(input.entryIds) ||
        input.entryIds.length < 1 ||
        input.entryIds.length > 100 ||
        new Set(input.entryIds).size !== input.entryIds.length
      )
        throw new ApplicationError(400, 'INVALID_DOCUMENT_REFERENCES');
      for (const id of input.entryIds) asId(id);
      return transaction(
        /** @returns {Promise<Object>} No revela ni distingue referencias ausentes e inaccesibles. */
        async () => {
          const listItem = [];
          for (const entryId of input.entryIds) {
            try {
              const value = await this.getOne({ entryId });
              listItem.push({
                ...value.item,
                repository : value.repository,
              });
            } catch (error) {
              if (!(error instanceof ApplicationError) || ![403, 404].includes(error.statusCode))
                throw error;
            }
          }
          return { listItem };
        },
      );
    },
    /** Página autorizada para Platform; recupera ancestros sin seguir movimientos entre raíces.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async getView(input) {
      return transaction(
        /** @returns {Promise<Object>} Datos, total y revisiones comparten la misma instantánea MongoDB. */
        async () => {
          dataInput(input);
          context();
          if (
            typeof input.favorites !== 'boolean' ||
            (input.trash !== undefined && typeof input.trash !== 'boolean') ||
            (input.trash && input.favorites) ||
            input.perPage !== 20
          )
            throw new ApplicationError(400, 'INVALID_DOCUMENT_VIEW');
          if (!Array.isArray(input.ancestors) || input.ancestors.length > 256)
            throw new ApplicationError(400, 'INVALID_DOCUMENT_VIEW');
          const ancestors = input.ancestors.map(
            /**
             * Proyecta cada elemento en la estructura requerida por la operación.
             * @param {*} id Valor de id utilizado por esta operación.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            (id) => asId(id, true),
          );
          let parentId    = asId(input.parentId, true);
          let page        = Number(input.page) || 1;
          /**
           * Lee el contenido o registro solicitado.
           * @param {number} index Valor de index utilizado por esta operación.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          let read        = (index) =>
            this.getFavorites({
              ...input,
              page : index,
            });
          if (input.trash) {
            parentId = null;
            /**
             * Lee el contenido o registro solicitado.
             * @param {number} index Valor de index utilizado por esta operación.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            read = (index) =>
              this.getTrash({
                ...input,
                page : index,
              });
          } else if (!input.favorites) {
            const root = await authorizeRoot(asId(input.repositoryId), 'view');
            /**
             * Lee el contenido o registro solicitado.
             * @param {number} index Valor de index utilizado por esta operación.
             * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            read = async (index) => {
              for (let attempt = 0; attempt < 3; attempt++) {
                const candidates = [parentId, ...[...ancestors].reverse(), null];
                let available    = null;
                for (const id of candidates) {
                  if (!id) break;
                  const folder = await entries.getOne(
                    {
                      _id          : id,
                      repositoryId : root._id,
                      type         : 'folder',
                      state        : 'active',
                      erased       : false,
                    },
                    entryGuest,
                  );
                  if (folder) {
                    available = id;
                    break;
                  }
                }
                if (!isSame(parentId, available)) {
                  page = index = 1;
                  parentId = available;
                }
                try {
                  return await this.getList({
                    ...input,
                    page     : index,
                    parentId : parentId ? String(parentId) : null,
                  });
                } catch (error) {
                  if (error.descriptionCode !== 'DOCUMENT_FOLDER_NOT_FOUND') throw error;
                }
              }
              throw new ApplicationError(503, 'DOCUMENT_VIEW_CHANGED');
            };
          }
          let result;
          for (let attempt = 0; attempt < 3; attempt++) {
            result = await read(page);
            const lastPage = Math.max(1, Math.ceil(result.totalCount / 20));
            if (page <= lastPage) break;
            if (attempt === 2) throw new ApplicationError(503, 'DOCUMENT_VIEW_CHANGED');
            page = lastPage;
          }
          let selected = null;
          if (input.selectedId) {
            try {
              selected = await this.getOne({
                entryId : input.selectedId,
                trash   : input.trash,
              });
            } catch (error) {
              if (![403, 404].includes(error.statusCode)) throw error;
            }
          }
          return {
            listItem    : result.listItem,
            totalCount  : result.totalCount,
            page,
            parentId    : parentId ? String(parentId) : null,
            repository  : result.repository || null,
            breadcrumbs : result.breadcrumbs || [],
            selected,
          };
        },
      );
    },
    /**
     * Compone createFolder con las dependencias recibidas y devuelve su interfaz.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async createFolder(input) {
      dataInput(input);
      context();
      const repositoryId = asId(input.repositoryId);
      const parentId     = asId(input.parentId, true);
      const name         = documentName(input.name);
      const item         = await transaction(
        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @param {Object} session Sesión que agrupa las operaciones de persistencia.
         * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        async (session) => {
          await lockRoots([repositoryId], session);
          const root = await authorizeRoot(repositoryId, 'create', session);
          if (root.kind === 'resource')
            throw new ApplicationError(403, 'DOCUMENT_RESOURCE_OPERATION_UNSUPPORTED');
          await requireParent(root, parentId, session);
          if (await collision(root, parentId, name, null, session))
            throw new ApplicationError(409, 'DOCUMENT_ALREADY_EXISTS');
          const created = await entries.create(
            {
              ...metadata(root),
              repositoryId,
              parentId,
              name,
              nameKey  : name,
              type     : 'folder',
              mimeType : 'inode/directory',
            },
            entryGuest,
            { session },
          );
          await entryChanged(created, 'create', session);
          return created;
        },
      );
      return entryDto(item);
    },
    /**
     * Ejecuta rename dentro del flujo de documents.service.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async rename(input) {
      dataInput(input);
      if ((await locateEntry(asId(input.entryId), 'update')).root.kind === 'resource')
        throw new ApplicationError(403, 'DOCUMENT_RESOURCE_OPERATION_UNSUPPORTED');
      context();
      const entryId          = asId(input.entryId);
      const name             = documentName(input.name);
      const expectedRevision = revision(input.expectedRevision);
      const initial          = await locateEntry(entryId, 'update');
      const item             = await transaction(
        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @param {Object} session Sesión que agrupa las operaciones de persistencia.
         * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        async (session) => {
          await lockRoots([initial.root._id], session, {
            [String(initial.root._id)] : input.expectedRepositoryRevision,
          });
          const { entry, root } = await locateEntry(entryId, 'update', session);
          if (entry.revision !== expectedRevision)
            throw new ApplicationError(409, 'DOCUMENT_REVISION_CONFLICT');
          if (entry.pendingOperation) throw new ApplicationError(409, 'DOCUMENT_OPERATION_PENDING');
          if (input.expectedSubtreeHash !== undefined)
            checkSubtreeRevision(input, await subtree(root, entry, session));
          if (await collision(root, entry.parentId, name, entryId, session))
            throw new ApplicationError(409, 'DOCUMENT_ALREADY_EXISTS');
          const renamed = await entries.update(
            {
              _id          : entryId,
              repositoryId : root._id,
              revision     : expectedRevision,
            },
            {
              $set : {
                name,
                nameKey    : name,
                updateDate : Date.now(),
              },
              $inc : { revision: 1 },
            },
            entryGuest,
            { session },
          );
          await entryChanged(renamed, 'rename', session);
          return renamed;
        },
      );
      return entryDto(item);
    },
    /**
     * Ejecuta move dentro del flujo de documents.service.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async move(input) {
      dataInput(input);
      if ((await locateEntry(asId(input.entryId), 'update')).root.kind === 'resource')
        throw new ApplicationError(403, 'DOCUMENT_RESOURCE_OPERATION_UNSUPPORTED');
      if ((await authorizeRoot(asId(input.targetRepositoryId), 'create')).kind === 'resource')
        throw new ApplicationError(403, 'DOCUMENT_RESOURCE_OPERATION_UNSUPPORTED');
      context();
      const entryId            = asId(input.entryId);
      const targetRepositoryId = asId(input.targetRepositoryId);
      const targetParentId     = asId(input.targetParentId, true);
      const expectedRevision   = revision(input.expectedRevision);
      const initial            = await locateEntry(entryId, 'update');
      const item               = await transaction(
        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @param {Object} session Sesión que agrupa las operaciones de persistencia.
         * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        async (session) => {
          await lockRoots([initial.root._id, targetRepositoryId], session, {
            [String(initial.root._id)] : input.expectedRepositoryRevision,
            ...(String(targetRepositoryId) !== String(initial.root._id)
              ? { [String(targetRepositoryId)]: input.expectedTargetRepositoryRevision }
              : {}),
          });
          const { entry, root } = await locateEntry(entryId, 'update', session);
          const target          = await authorizeRoot(targetRepositoryId, 'create', session);
          if (entry.revision !== expectedRevision)
            throw new ApplicationError(409, 'DOCUMENT_REVISION_CONFLICT');
          if (isSame(root._id, target._id) && isSame(entry.parentId, targetParentId))
            throw new ApplicationError(409, 'DOCUMENT_SAME_PARENT');
          await requireParent(target, targetParentId, session);
          const tree = await subtree(root, entry, session);
          checkSubtreeRevision(input, tree);
          if (
            tree.some(
              /**
               * Comprueba si el elemento satisface la condición.
               * @param {*} node Valor de node utilizado por esta operación.
               * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
               */
              (node) => isSame(node._id, targetParentId),
            )
          )
            throw new ApplicationError(409, 'DOCUMENT_MOVE_CYCLE');
          if (await collision(target, targetParentId, entry.name, entryId, session))
            throw new ApplicationError(409, 'DOCUMENT_ALREADY_EXISTS');
          const bytes = tree.reduce(
            /**
             * Acumula el resultado de los elementos recorridos.
             * @param {*} sum Valor de sum utilizado por esta operación.
             * @param {*} node Valor de node utilizado por esta operación.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            (sum, node) => sum + node.size,
            0,
          );
          if (!isSame(root._id, target._id)) {
            if (
              tree.some(
                /**
                 * Comprueba si el elemento satisface la condición.
                 * @param {*} node Valor de node utilizado por esta operación.
                 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                 */
                (node) => node.type === 'file' && node.size > target.sizeFileMax,
              )
            )
              throw new ApplicationError(413, 'DOCUMENT_FILE_TOO_LARGE');
            if (target.usedSpace + target.reservedSpace + bytes > target.availableSpace)
              throw new ApplicationError(409, 'DOCUMENT_CAPACITY_EXCEEDED');
            await roots.update({ _id: root._id }, { $inc: { usedSpace: -bytes } }, rootGuest, {
              session,
            });
            await roots.update({ _id: target._id }, { $inc: { usedSpace: bytes } }, rootGuest, {
              session,
            });
            await entries.updateMany(
              {
                repositoryId : root._id,
                _id          : {
                  $in : tree
                    .filter(
                      /**
                       * Determina si el elemento cumple el criterio de selección.
                       * @param {*} node Valor de node utilizado por esta operación.
                       * @returns {boolean} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                       */
                      (node) => !isSame(node._id, entryId),
                    )
                    .map(
                      /**
                       * Proyecta cada elemento en la estructura requerida por la operación.
                       * @param {*} node Valor de node utilizado por esta operación.
                       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                       */
                      (node) => node._id,
                    ),
                },
              },
              {
                $set : {
                  repositoryId : target._id,
                  workspace    : target.workspace,
                  updateDate   : Date.now(),
                },
                $inc : { revision: 1 },
              },
              entryGuest,
              { session },
            );
          }
          const changes    = {
            $set : {
              repositoryId : target._id,
              workspace    : target.workspace,
              parentId     : targetParentId,
              updateDate   : Date.now(),
            },
            $inc : { revision: 1 },
          };
          const moved      = await entries.update(
            {
              _id          : entryId,
              repositoryId : root._id,
              revision     : expectedRevision,
            },
            changes,
            entryGuest,
            { session },
          );
          const changeCode = `${entryId}:${moved.revision}`;
          const previous   = {
            previousRepositoryId : String(root._id),
            previousParentId     : entry.parentId ? String(entry.parentId) : null,
          };
          await entryChanged(moved, 'move', session, changeCode, previous);
          for (const node of tree.filter(
            /**
             * Determina si el elemento cumple el criterio de selección.
             * @param {*} node Valor de node utilizado por esta operación.
             * @returns {boolean} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            (node) => !isSame(node._id, entryId),
          )) {
            await entryChanged(
              {
                ...node,
                _id          : node._id,
                repositoryId : target._id,
                workspace    : target.workspace,
                revision     : node.revision + (isSame(root._id, target._id) ? 0 : 1),
              },
              'move',
              session,
              changeCode,
              {
                previousRepositoryId : String(root._id),
                previousParentId     : node.parentId ? String(node.parentId) : null,
              },
            );
          }
          return moved;
        },
      );
      return entryDto(item);
    },
    /** Envía el árbol completo a papelera sin tocar S3 ni liberar su cuota.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async delete(input) {
      dataInput(input);
      context();
      const entryId          = asId(input.entryId);
      const expectedRevision = revision(input.expectedRevision);
      const initial          = await locateEntry(entryId, 'delete');
      const setting          = await settingsRepository.get('documents-settings', settingsGuest);
      if (!setting?.data) throw new ApplicationError(503, 'DOCUMENT_SETTINGS_INVALID');
      const trashedAt    = Date.now();
      const purgeAfter   = trashedAt + trashRetentionDays(setting?.data) * 86400000;
      const deletedCount = await transaction(
        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @param {Object} session Sesión que agrupa las operaciones de persistencia.
         * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        async (session) => {
          await lockRoots([initial.root._id], session, {
            [String(initial.root._id)] : input.expectedRepositoryRevision,
          });
          const { entry, root } = await locateEntry(entryId, 'delete', session);
          if (entry.revision !== expectedRevision)
            throw new ApplicationError(409, 'DOCUMENT_REVISION_CONFLICT');
          const tree = await subtree(root, entry, session);
          checkSubtreeRevision(input, tree);
          await favorites.deleteMany(
            {
              entryId : {
                $in : tree.map(
                  /**
                   * Proyecta cada elemento en la estructura requerida por la operación.
                   * @param {*} node Valor de node utilizado por esta operación.
                   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                   */
                  (node) => node._id,
                ),
              },
            },
            false,
            favoriteGuest,
            { session },
          );
          await entries.updateMany(
            {
              repositoryId : root._id,
              _id          : {
                $in : tree.map(
                  /**
                   * Proyecta cada elemento en la estructura requerida por la operación.
                   * @param {*} node Valor de node utilizado por esta operación.
                   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                   */
                  (node) => node._id,
                ),
              },
            },
            {
              $set : {
                state       : 'trashed',
                trashRootId : entry._id,
                trashedAt,
                purgeAfter,
                updateDate  : trashedAt,
              },
              $inc : { revision: 1 },
            },
            entryGuest,
            { session },
          );
          for (const node of tree)
            await entryChanged(
              {
                ...node,
                revision : node.revision + 1,
              },
              'trash',
              session,
            );
          return tree.length;
        },
      );
      return {
        deletedCount,
        purgeAfter,
      };
    },
    /**
     * Resuelve getTrash aplicando los filtros y colaboradores del módulo.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async getTrash(input) {
      return transaction(
        /** @returns {Promise<Object>} Filas, pertenencia, agregados y revisiones desde la misma instantánea del productor. */
        async () => {
          dataInput(input);
          const current    = requestContext();
          const root       = await authorizeRoot(asId(input.repositoryId), 'view');
          const options    = listOptions(input);
          const result     = await entries.getList(
            {
              ...options.filter,
              repositoryId : root._id,
              state        : 'trashed',
              $expr        : { $eq: ['$_id', '$trashRootId'] },
            },
            options.sort,
            options.page,
            options.perPage,
            '',
            entryGuest,
          );
          const projection = await pageProjection(result.listItem, [root], current);
          return {
            listItem    : await Promise.all(
              result.listItem.map(
                /**
                 * Proyecta cada elemento en la estructura requerida por la operación.
                 * @param {*} entry Valor de entry utilizado por esta operación.
                 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                 */
                (entry) => entryDto(entry, root, false, projection),
              ),
            ),
            totalCount  : result.totalCount,
            repository  : projection.roots.get(String(root._id)),
            folder      : null,
            breadcrumbs : [
              {
                id   : null,
                name : 'Papelera',
              },
            ],
          };
        },
      );
    },
    /** Restaura atómicamente en el padre original o en un destino explícito de drag & drop.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async restore(input) {
      dataInput(input);
      context();
      const entryId          = asId(input.entryId);
      const expectedRevision = revision(input.expectedRevision);
      const explicitTarget   = input.targetRepositoryId !== undefined;
      if (!explicitTarget && input.targetParentId !== undefined)
        throw new ApplicationError(400, 'INVALID_DOCUMENT_INPUT');
      const initial            = await locateTrashEntry(entryId, 'update');
      const targetRepositoryId = explicitTarget ? asId(input.targetRepositoryId) : initial.root._id;
      const targetParentId     = explicitTarget ? asId(input.targetParentId, true) : null;
      const restored           = await transaction(
        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @param {Object} session Sesión que agrupa las operaciones de persistencia.
         * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        async (session) => {
          await lockRoots([initial.root._id, targetRepositoryId], session, {
            [String(initial.root._id)] : input.expectedRepositoryRevision,
            ...(String(targetRepositoryId) !== String(initial.root._id)
              ? { [String(targetRepositoryId)]: input.expectedTargetRepositoryRevision }
              : {}),
          });
          const { entry, root } = await locateTrashEntry(entryId, 'update', session);
          const target          = await authorizeRoot(targetRepositoryId, 'create', session);
          if (
            (root.kind === 'resource' || target.kind === 'resource') &&
            !isSame(root._id, target._id)
          )
            throw new ApplicationError(403, 'DOCUMENT_RESOURCE_OPERATION_UNSUPPORTED');
          if (entry.revision !== expectedRevision)
            throw new ApplicationError(409, 'DOCUMENT_REVISION_CONFLICT');
          if (entry.purgeAfter <= Date.now())
            throw new ApplicationError(409, 'DOCUMENT_TRASH_EXPIRED');
          let parentId = targetParentId;
          if (explicitTarget) await requireParent(target, parentId, session);
          else {
            const parent = entry.parentId
              ? await entries.getOne(
                  {
                    _id          : entry.parentId,
                    repositoryId : root._id,
                    type         : 'folder',
                    state        : 'active',
                    erased       : false,
                  },
                  entryGuest,
                  'view',
                  undefined,
                  { session },
                )
              : null;
            parentId = parent?._id || null;
          }
          if (await collision(target, parentId, entry.name, null, session))
            throw new ApplicationError(409, 'DOCUMENT_ALREADY_EXISTS');
          const tree = await readAll(
            /**
             * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
             * @param {number} page Índice de la página según el contrato de esta operación.
             * @param {number} perPage Cantidad máxima de elementos por página.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            (page, perPage) =>
              entries.getList(
                {
                  repositoryId : root._id,
                  state        : 'trashed',
                  trashRootId  : entry._id,
                },
                { _id: 1 },
                page,
                perPage,
                '',
                entryGuest,
                { session },
              ),
          );
          if (
            tree.listItem.some(
              /**
               * Comprueba si el elemento satisface la condición.
               * @param {*} node Valor de node utilizado por esta operación.
               * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
               */
              (node) => isSame(node._id, parentId),
            )
          )
            throw new ApplicationError(409, 'DOCUMENT_MOVE_CYCLE');
          if (!isSame(root._id, target._id)) {
            const bytes = tree.listItem.reduce(
              /**
               * Acumula el resultado de los elementos recorridos.
               * @param {*} sum Valor de sum utilizado por esta operación.
               * @param {*} node Valor de node utilizado por esta operación.
               * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
               */
              (sum, node) => sum + node.size,
              0,
            );
            if (
              tree.listItem.some(
                /**
                 * Comprueba si el elemento satisface la condición.
                 * @param {*} node Valor de node utilizado por esta operación.
                 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                 */
                (node) => node.type === 'file' && node.size > target.sizeFileMax,
              )
            )
              throw new ApplicationError(413, 'DOCUMENT_FILE_TOO_LARGE');
            if (target.usedSpace + target.reservedSpace + bytes > target.availableSpace)
              throw new ApplicationError(409, 'DOCUMENT_CAPACITY_EXCEEDED');
            await roots.update({ _id: root._id }, { $inc: { usedSpace: -bytes } }, rootGuest, {
              session,
            });
            await roots.update({ _id: target._id }, { $inc: { usedSpace: bytes } }, rootGuest, {
              session,
            });
          }
          // El padre se fija antes de activar el nombre bajo el índice único del destino.
          await entries.update(
            {
              _id   : entry._id,
              state : 'trashed',
            },
            { $set: { parentId } },
            entryGuest,
            { session },
          );
          await entries.updateMany(
            {
              repositoryId : root._id,
              state        : 'trashed',
              trashRootId  : entry._id,
            },
            {
              $set : {
                repositoryId : target._id,
                workspace    : target.workspace,
                state        : 'active',
                trashRootId  : null,
                trashedAt    : 0,
                purgeAfter   : 0,
                updateDate   : Date.now(),
              },
              $inc : { revision: 1 },
            },
            entryGuest,
            { session },
          );
          const item = await entries.getOne(
            {
              _id          : entry._id,
              repositoryId : target._id,
            },
            entryGuest,
            'view',
            undefined,
            { session },
          );
          for (const node of tree.listItem)
            await entryChanged(
              {
                ...node,
                repositoryId : target._id,
                workspace    : target.workspace,
                parentId     : isSame(node._id, entry._id) ? parentId : node.parentId,
                revision     : node.revision + 1,
              },
              'restore',
              session,
              '',
              {
                previousRepositoryId : String(root._id),
                previousParentId     : node.parentId ? String(node.parentId) : null,
              },
            );
          return item;
        },
      );
      return entryDto(restored);
    },
    /** @param {Object} receipt Recibo interno con destino original. @returns {Promise<Object>} Raíz aún autorizada para recuperar la intención. */
    async authorizeReceipt(receipt) {
      return authorizeRoot(asId(receipt.repositoryId), receipt.action);
    },
    /** @returns {Promise<Object>} Límites globales y revisión de la configuración. */
    async getSettings() {
      return transaction(
        /** @returns {Promise<Object>} Filas, pertenencia, agregados y revisiones desde la misma instantánea del productor. */
        async () => {
          const actor = context();
          if (!actor.policies.includes('documents.settings.view.global'))
            throw new ApplicationError(403, 'FORBIDDEN');
          const value = await settingsRepository.get('documents-settings', 'global');
          if (!value) throw new ApplicationError(404, 'DOCUMENT_SETTINGS_NOT_FOUND');
          return {
            revision : value.revision || 0,
            data     : {
              availableSpace     : value.data.availableSpace,
              sizeFileMax        : value.data.sizeFileMax,
              trashRetentionDays : trashRetentionDays(value.data),
            },
          };
        },
      );
    },
    /** @param {Object} input Límites y revisión esperada. @returns {Promise<Object>} Configuración confirmada; no cambia cuotas de raíces existentes. */
    async updateSettings(input) {
      const actor = context();
      if (!actor.policies.includes('documents.settings.update.global'))
        throw new ApplicationError(403, 'FORBIDDEN');
      if (input.data.sizeFileMax > input.data.availableSpace)
        throw new ApplicationError(400, 'INVALID_DOCUMENT_SETTINGS');
      const value = await settingsRepository.update(
        'documents-settings',
        input.data,
        'global',
        input.expectedRevision,
      );
      return {
        revision : value.revision,
        data     : {
          availableSpace     : value.data.availableSpace,
          sizeFileMax        : value.data.sizeFileMax,
          trashRetentionDays : trashRetentionDays(value.data),
        },
      };
    },
    /** @param {Object} input Metadatos de una transferencia acotada. @returns {Promise<Object>} Destino autorizado y límite vigente sin reservar bytes. */
    async prepareUpload(input) {
      dataInput(input);
      context();
      const repositoryId = asId(input.repositoryId),
        parentId         = asId(input.parentId, true),
        name             = documentName(input.fileName);
      const root = await authorizeRoot(repositoryId, input.overwrite ? 'update' : 'create');
      await requireParent(root, parentId);
      const existing = await collision(root, parentId, name);
      if (input.entryId && (!existing || !isSame(existing._id, asId(input.entryId))))
        throw new ApplicationError(409, 'DOCUMENT_REVISION_CONFLICT');
      if (existing?.type === 'folder') throw new ApplicationError(409, 'DOCUMENT_FOLDER_EXISTS');
      if (existing && !input.overwrite) throw new ApplicationError(409, 'DOCUMENT_ALREADY_EXISTS');
      if (input.overwrite && input.expectedRevision === undefined)
        throw new ApplicationError(400, 'INVALID_DOCUMENT_REVISION');
      if (existing && existing.revision !== input.expectedRevision)
        throw new ApplicationError(409, 'DOCUMENT_REVISION_CONFLICT');
      if (input.byteLength > root.sizeFileMax)
        throw new ApplicationError(413, 'DOCUMENT_FILE_TOO_LARGE');
      if (
        root.usedSpace +
          root.reservedSpace +
          Math.max(0, input.byteLength - (existing?.size || 0)) >
        root.availableSpace
      )
        throw new ApplicationError(409, 'DOCUMENT_CAPACITY_EXCEEDED');
      return {
        fileName   : name,
        mimeType   : input.mimeType || 'application/octet-stream',
        byteLength : input.byteLength,
        sha256     : input.sha256,
        maxBytes   : root.sizeFileMax,
      };
    },
    /** @param {Object} input Archivo autorizado. @returns {Promise<Object>} Metadata necesaria para transferir contenido privado. */
    async prepareDownload(input) {
      const { entry } = await locateEntry(asId(input.entryId), 'view');
      if (input.expectedRevision !== undefined && entry.revision !== input.expectedRevision)
        throw new ApplicationError(409, 'DOCUMENT_REVISION_CONFLICT');
      if (entry.type !== 'file') throw new ApplicationError(400, 'DOCUMENT_NOT_FILE');
      return {
        fileName   : entry.name,
        mimeType   : entry.mimeType,
        byteLength : entry.size,
        revision   : entry.revision,
        sha256     : entry.sha256 || null,
      };
    },
    /** @param {Object} input Clave de la carga original. @returns {Promise<Object>} Resultado confirmado o estado pendiente sin volver a subir. */
    async uploadStatus(input) {
      const current = context();
      if (!current.delegation) throw new ApplicationError(403, 'DOCUMENT_DELEGATION_REQUIRED');
      const key       = unitOfWork.hash([
        current.user.userCode,
        current.workspace,
        current.delegation,
        'documents-file-upload',
        input.idempotencyKey,
      ]);
      const operation = await operations.getOne(
        {
          _id        : ids.parse(key.slice(0, 24)),
          requestKey : key,
        },
        operationGuest,
      );
      if (!operation) throw new ApplicationError(404, 'DOCUMENT_OPERATION_NOT_FOUND');
      await authorizeRoot(operation.repositoryId, operation.isNewEntry ? 'create' : 'update');
      return {
        state : operation.result
          ? 'complete'
          : ['abandoned', 'failed'].includes(operation.state)
            ? 'failed'
            : 'pending',
        ...(operation.result ? { item: operation.result } : {}),
      };
    },
    /**
     * Ejecuta upload dentro del flujo de documents.service.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async upload(input) {
      dataInput(input);
      context();
      let heartbeat;
      let operation;
      const tempFilePath = input.tempFilePath;
      try {
        await temporaryFiles.validate(tempFilePath);
        const repositoryId = asId(input.repositoryId);
        const parentId     = asId(input.parentId, true);
        const name         = documentName(input.fileName);
        if (!['true', 'false', true, false, undefined].includes(input.overwrite))
          throw new ApplicationError(400, 'INVALID_DOCUMENT_OVERWRITE');
        const canOverwrite     = input.overwrite === true || input.overwrite === 'true';
        const expectedRevision =
          input.expectedRevision === undefined ? null : revision(input.expectedRevision);
        const mimeType         = input.mimeType || 'application/octet-stream';
        if (typeof mimeType !== 'string' || mimeType.length > 255 || /[\r\n\0]/.test(mimeType))
          throw new ApplicationError(400, 'INVALID_DOCUMENT_MIME');
        const fileStat = await temporaryFiles.promises.stat(tempFilePath);
        if (!fileStat.isFile() || fileStat.size > MAX_UPLOAD)
          throw new ApplicationError(413, 'DOCUMENT_FILE_TOO_LARGE');
        const bytes    = await temporaryFiles.promises.readFile(tempFilePath);
        const size     = bytes.length;
        const checksum = createHash('sha256').update(bytes).digest('hex');
        const actor    = context();
        const key      = actor.operation?.idempotencyKey;
        if (actor.delegation && (typeof key !== 'string' || key.length < 16 || key.length > 128))
          throw new ApplicationError(400, 'IDEMPOTENCY_KEY_REQUIRED');
        const requestKey         = actor.delegation
          ? unitOfWork.hash([
              actor.user.userCode,
              actor.workspace,
              actor.delegation,
              'documents-file-upload',
              key,
            ])
          : null;
        const requestFingerprint = requestKey
          ? unitOfWork.hash({
              entryId      : input.entryId || null,
              repositoryId : String(repositoryId),
              parentId     : String(parentId || ''),
              name,
              canOverwrite,
              expectedRevision,
              mimeType,
              size,
              checksum,
            })
          : null;
        if (actor.delegation && canOverwrite && expectedRevision === null)
          throw new ApplicationError(400, 'INVALID_DOCUMENT_REVISION');
        if (
          (input.sha256 !== undefined && input.sha256 !== checksum) ||
          (input.byteLength !== undefined && input.byteLength !== size)
        )
          throw new ApplicationError(400, 'DOCUMENT_CONTENT_MISMATCH');
        const operationId = requestKey ? ids.parse(requestKey.slice(0, 24)) : ids.create();
        if (requestKey) {
          const previous = await operations.getOne({ _id: operationId }, operationGuest);
          if (previous) {
            if (
              previous.requestKey !== requestKey ||
              previous.requestFingerprint !== requestFingerprint
            )
              throw new ApplicationError(409, 'IDEMPOTENCY_KEY_CONFLICT');
            await authorizeRoot(previous.repositoryId, previous.isNewEntry ? 'create' : 'update');
            if (previous.result) return previous.result;
            throw new ApplicationError(
              409,
              ['abandoned', 'failed'].includes(previous.state)
                ? 'DOCUMENT_UPLOAD_FAILED'
                : 'DOCUMENT_OPERATION_PENDING',
            );
          }
        }
        const storageKey = `documents-repository/v1/${env.ENV_NAME}/blobs/${randomUUID()}`;
        operation = await transaction(
          /**
           * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
           * @param {Object} session Sesión que agrupa las operaciones de persistencia.
           * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          async (session) => {
            await lockRoots([repositoryId], session);
            if (requestKey) {
              const accepted = await operations.getOne(
                { _id: operationId },
                operationGuest,
                'view',
                undefined,
                { session },
              );
              if (accepted)
                throw new ApplicationError(
                  409,
                  accepted.requestKey !== requestKey ||
                    accepted.requestFingerprint !== requestFingerprint
                    ? 'IDEMPOTENCY_KEY_CONFLICT'
                    : 'DOCUMENT_OPERATION_PENDING',
                );
            }
            const root = await roots.getOne({ _id: repositoryId }, rootGuest, 'view', undefined, {
              session,
            });
            if (!root) throw new ApplicationError(404, 'DOCUMENT_REPOSITORY_NOT_FOUND');
            const existing = await collision(root, parentId, name, null, session);
            let authorizedRoot;
            if (existing && !canOverwrite) {
              try {
                authorizedRoot = await authorizeRoot(repositoryId, 'create', session);
              } catch (error) {
                if (error.statusCode !== 403) throw error;
                authorizedRoot = await authorizeRoot(repositoryId, 'update', session);
              }
            } else
              authorizedRoot = await authorizeRoot(
                repositoryId,
                existing ? 'update' : 'create',
                session,
              );
            await requireParent(root, parentId, session);
            if (size > root.sizeFileMax) throw new ApplicationError(413, 'DOCUMENT_FILE_TOO_LARGE');
            if (input.entryId && (!existing || !isSame(existing._id, asId(input.entryId))))
              throw new ApplicationError(409, 'DOCUMENT_REVISION_CONFLICT');
            if (existing?.type === 'folder')
              throw new ApplicationError(409, 'DOCUMENT_FOLDER_EXISTS');
            if (existing && !canOverwrite)
              throw new ApplicationError(409, 'DOCUMENT_ALREADY_EXISTS');
            if (existing?.pendingOperation || existing?.state === 'uploading')
              throw new ApplicationError(409, 'DOCUMENT_OPERATION_PENDING');
            if (existing && expectedRevision !== null && expectedRevision !== existing.revision)
              throw new ApplicationError(409, 'DOCUMENT_REVISION_CONFLICT');
            const reservedSpace = Math.max(0, size - (existing?.size || 0));
            if (root.usedSpace + root.reservedSpace + reservedSpace > root.availableSpace)
              throw new ApplicationError(409, 'DOCUMENT_CAPACITY_EXCEEDED');
            const entry =
              existing ||
              (await entries.create(
                {
                  ...metadata(authorizedRoot),
                  repositoryId,
                  parentId,
                  name,
                  nameKey          : name,
                  type             : 'file',
                  state            : 'uploading',
                  pendingOperation : operationId,
                },
                entryGuest,
                { session },
              ));
            if (existing)
              await entries.update(
                {
                  _id      : entry._id,
                  repositoryId,
                  revision : entry.revision,
                },
                { $set: { pendingOperation: operationId } },
                entryGuest,
                { session },
              );
            await roots.update({ _id: repositoryId }, { $inc: { reservedSpace } }, rootGuest, {
              session,
            });
            return operations.create(
              {
                ...metadata(root),
                _id                : operationId,
                kind               : 'upload',
                executionWorkspace : actor.workspace,
                ...(requestKey
                  ? {
                      requestKey,
                      requestFingerprint,
                      delegation         : actor.delegation,
                      executionWorkspace : actor.workspace,
                    }
                  : {}),
                repositoryId,
                entryId            : entry._id,
                parentId,
                name,
                storageKey,
                oldStorageKey      : existing?.storageKey || '',
                size,
                oldSize            : existing?.size || 0,
                reservedSpace,
                mimeType,
                checksum,
                expectedRevision   : entry.revision,
                isNewEntry         : !existing,
                tempFilePath,
                leaseUntil         : Date.now() + LEASE_MS,
                settleUntil        : Date.now() + STORAGE_SETTLE_MS,
              },
              operationGuest,
              { session },
            );
          },
        );
        heartbeat = setInterval(
          /**
           * Ejecuta la operación periódica configurada.
           * @returns {void} Finaliza después de aplicar los efectos de la operación.
           */
          () => {
            void operations
              .update(
                {
                  _id   : operation._id,
                  state : 'pending',
                },
                {
                  $set : {
                    leaseUntil  : Date.now() + LEASE_MS,
                    settleUntil : Date.now() + STORAGE_SETTLE_MS,
                  },
                },
                operationGuest,
              )
              .catch(
                /**
                 * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
                 * @returns {void} Finaliza después de aplicar los efectos de la operación.
                 */
                () => {},
              );
          },
          15000,
        );
        heartbeat.unref?.();
        let effectStarted = false;
        try {
          if (operation.delegation) {
            const live = await delegatedUploadActor(operation);
            if (!live) {
              await abortUpload(operation);
              throw new ApplicationError(401, 'OAUTH_CONNECTION_REVOKED');
            }
            await messaging.runWithContext(
              live,
              /** @returns {Promise<Object>} Comprueba el destino antes del efecto externo. */ () =>
                authorizeRoot(operation.repositoryId, operation.isNewEntry ? 'create' : 'update'),
            );
          }
          effectStarted = true;
          await storage.put({
            key       : storageKey,
            content   : bytes,
            mimeType,
            checksum,
            operation : String(operation._id),
            signal    : AbortSignal.timeout(30000),
          });
          const item = await finishUpload(operation);
          if (!item)
            throw new ApplicationError(503, 'STORAGE_WRITE_UNCERTAIN', { uncertain: true });
          if (requestKey)
            return (await operations.getOne({ _id: operationId }, operationGuest)).result;
          return entryDto(item);
        } catch (error) {
          if (!effectStarted) {
            await abortUpload(operation);
            throw error;
          }
          const settleUntil = Date.now() + STORAGE_SETTLE_MS;
          await operations
            .update(
              {
                _id   : operation._id,
                state : 'pending',
              },
              {
                $set : {
                  leaseUntil : settleUntil,
                  settleUntil,
                },
              },
              operationGuest,
            )
            .catch(
              /**
               * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
               * @returns {void} Finaliza después de aplicar los efectos de la operación.
               */
              () => {},
            );
          throw new ApplicationError(503, 'STORAGE_WRITE_UNCERTAIN', {
            cause     : error,
            uncertain : true,
          });
        }
      } finally {
        clearInterval(heartbeat);
        if (typeof tempFilePath === 'string')
          await temporaryFiles.remove(tempFilePath).catch(
            /**
             * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
             * @returns {void} Finaliza después de aplicar los efectos de la operación.
             */
            () => {},
          );
      }
    },
    /**
     * Ejecuta download dentro del flujo de documents.service.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async download(input) {
      dataInput(input);
      context();
      const { entry } = await locateEntry(asId(input.entryId), 'view');
      if (input.expectedRevision !== undefined && entry.revision !== input.expectedRevision)
        throw new ApplicationError(409, 'DOCUMENT_REVISION_CONFLICT');
      if (entry.type !== 'file') throw new ApplicationError(400, 'DOCUMENT_NOT_FILE');
      const tempFilePath = temporaryFiles.uniquePath(entry.name);
      try {
        const body = await storage.read(entry.storageKey);
        await temporaryFiles.promises.writeFile(tempFilePath, body);
        return {
          tempFilePath,
          revision : entry.revision,
          sha256   : entry.sha256 || null,
          fileName : entry.name,
          mimeType : entry.mimeType,
        };
      } catch (error) {
        await temporaryFiles.remove(tempFilePath).catch(
          /**
           * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
           * @returns {void} Finaliza después de aplicar los efectos de la operación.
           */
          () => {},
        );
        throw new ApplicationError(503, 'DOCUMENT_CONTENT_UNAVAILABLE', { cause: error });
      }
    },
    /**
     * Resuelve getFavorites aplicando los filtros y colaboradores del módulo.
     * @param {Object} [input] Entrada que se procesa con las reglas del módulo.
     * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async getFavorites(input = {}) {
      return transaction(
        /** @returns {Promise<Object>} Filas, pertenencia, agregados y revisiones desde la misma instantánea del productor. */
        async () => {
          dataInput(input);
          const current = requestContext();
          if (
            input.kind !== undefined &&
            !['', 'personal', 'workspace', 'global'].includes(input.kind)
          )
            throw new ApplicationError(400, 'INVALID_DOCUMENT_FILTER');
          const options    = listOptions(input);
          const rootFilter = input.kind
            ? allowedFilter(input.kind, 'view') || { _id: { $exists: false } }
            : allAllowed();
          const result     = await favorites.getJoinedList(
            {
              userCreate : current.user.userCode,
              erased     : false,
            },
            rootFilter,
            options.filter,
            options.sort,
            options.page,
            options.perPage,
            favoriteGuest,
          );
          const rootItems  = [
            ...new Map(
              result.listItem.map(
                /**
                 * Proyecta cada elemento en la estructura requerida por la operación.
                 * @param {*} item Valor de item utilizado por esta operación.
                 * @returns {Array<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                 */
                (item) => [String(item.repository._id), item.repository],
              ),
            ).values(),
          ];
          const projection = await pageProjection(result.listItem, rootItems, current);
          return {
            listItem   : await Promise.all(
              result.listItem.map(
                /**
                 * Proyecta cada elemento en la estructura requerida por la operación.
                 * @param {*} item Valor de item utilizado por esta operación.
                 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                 */
                (item) => entryDto(item, item.repository, true, projection),
              ),
            ),
            totalCount : result.totalCount,
          };
        },
      );
    },
    /**
     * Ejecuta addFavorite dentro del flujo de documents.service.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async addFavorite(input) {
      dataInput(input);
      const current = context();
      const entryId = asId(input.entryId);
      const initial = await locateEntry(entryId, 'view');
      await transaction(
        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @param {Object} session Sesión que agrupa las operaciones de persistencia.
         * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
         */
        async (session) => {
          await lockRoots([initial.root._id], session);
          const { entry, root } = await locateEntry(entryId, 'view', session);
          if (!isSame(root._id, initial.root._id))
            throw new ApplicationError(409, 'DOCUMENT_REVISION_CONFLICT');
          const filter = {
            entryId,
            userCreate : current.user.userCode,
            erased     : false,
          };
          if (!(await favorites.getOne(filter, favoriteGuest, 'view', undefined, { session })))
            await favorites.create(
              {
                workspace     : 'allWorkspaces',
                userCreate    : current.user.userCode,
                userAssigned  : '',
                entryId       : entry._id,
                idTransaction : current.idTransaction || '',
              },
              favoriteGuest,
              { session },
            );
          await entryChanged(entry, 'favorite', session, randomUUID(), {
            userCode : current.user.userCode,
          });
        },
      );
      return { isFavorite: true };
    },
    /**
     * Ejecuta removeFavorite dentro del flujo de documents.service.
     * @param {Object} input Entrada que se procesa con las reglas del módulo.
     * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async removeFavorite(input) {
      dataInput(input);
      const current = context();
      const entryId = asId(input.entryId);
      await transaction(
        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @param {Object} session Sesión que agrupa las operaciones de persistencia.
         * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
         */
        async (session) => {
          const repositoryId = await entries.resolveRepositoryId(entryId, entryGuest, { session });
          if (repositoryId) await lockRoots([repositoryId], session);
          const entry = repositoryId
            ? await entries.getOne({ _id: entryId }, entryGuest, 'view', undefined, { session })
            : null;
          await favorites.deleteOne(
            {
              entryId,
              userCreate : current.user.userCode,
            },
            false,
            favoriteGuest,
            { session },
          );
          await entryChanged(
            entry || {
              _id          : entryId,
              repositoryId : '',
              revision     : 0,
              workspace    : '',
            },
            'favorite',
            session,
            randomUUID(),
            { userCode: current.user.userCode },
          );
        },
      );
      return { isFavorite: false };
    },
  };
};
