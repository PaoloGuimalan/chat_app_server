/**
 * Node-side port of the entity permissions system defined in the Django
 * user_service repo (entity/permissions.py, entity/services/permission_resolver.py).
 * Both repos share the same Postgres tables (entity_permission,
 * community_member, entity_permission_catalog, entity_role_permissions),
 * so this hand-ports the same priority logic rather than calling into
 * Django - keep the two files in sync when either changes:
 *   - user_service/entity/permissions.py
 *   - user_service/entity/services/permission_resolver.py
 *   - user_service/entity/services/permission_catalog_cache.py
 *
 * The permission catalog, role-default matrix, and entity-type-default
 * matrix are DATABASE-BACKED (entity_permission_catalog,
 * entity_role_permissions, entity_permission_catalog_entity_types joined to
 * entity_type), not hardcoded
 * here - both repos read the same shared Redis instance
 * (permcache:catalog:v4 / permcache:role_matrix:v3:<realm> /
 * permcache:entity_type_matrix:v1, plain JSON strings) with a direct-query
 * fallback on a cache miss, so an admin editing the catalog on the Django
 * side is visible here without a deploy.
 *
 * Resolution priority (highest to lowest):
 *   1. The immutable realm Owner holds all active realm capabilities.
 *   2. Explicit entity deny/grant for the exact scope (including globals).
 *   3. Entity-type default (entity_type-scoped) OR role-derived default
 *      (realm-scoped) OR platform default (global-scoped).
 *   4. Deny-by-default fallback -> false.
 */

const redis = require("redis");
const pool = require("../database/postgres");
const { permissionApplies } = require("../models/permissionApplicability");
const { REDIS_HOST, REDIS_PORT, REDIS_USERNAME, REDIS_PASSWORD } = require("../vars/redis");

const CATALOG_CACHE_KEY = "permcache:catalog:v4";
const ROLE_MATRIX_CACHE_KEY = "permcache:role_matrix:v3";
const ENTITY_TYPE_MATRIX_CACHE_KEY = "permcache:entity_type_matrix:v1";
const CACHE_TTL_SECONDS = 60 * 60; // safety-net only; Django invalidates on write
// Keep aligned with entity/permissions.py::GLOBAL_PLATFORM_DEFAULT. Other
// global catalog entries, including developer API scopes, require a grant.
const GLOBAL_PLATFORM_DEFAULT = new Set([
  "messages.send",
  "messages.react",
  "conversations.create",
  "posts.create",
  "comments.create",
  "contacts.request.create",
  "poke.create",
  "ai.prompt.assist",
  "webrtc.call.join",
  "realm.server.create",
]);

let cacheClient = null;

async function _getCacheClient() {
  if (!cacheClient) {
    cacheClient = redis.createClient({
      username: REDIS_USERNAME,
      password: REDIS_PASSWORD,
      socket: { host: REDIS_HOST, port: REDIS_PORT },
    });
    cacheClient.on("error", (err) =>
      console.error("Permission cache Redis error:", err),
    );
    await cacheClient.connect();
  }
  return cacheClient;
}

async function _cacheGet(key) {
  try {
    const client = await _getCacheClient();
    return await client.get(key);
  } catch (err) {
    console.error(`Permission cache read failed for ${key}, falling back to DB:`, err);
    return null;
  }
}

async function _cacheSet(key, value) {
  try {
    const client = await _getCacheClient();
    await client.set(key, value, { EX: CACHE_TTL_SECONDS });
  } catch (err) {
    console.error(`Permission cache write failed for ${key} (non-fatal):`, err);
  }
}

async function getCatalog() {
  const cached = await _cacheGet(CATALOG_CACHE_KEY);
  if (cached) {
    return JSON.parse(cached);
  }

  const { rows } = await pool.query(
    `SELECT code, scope, is_active, ARRAY(SELECT kind.code
      FROM entity_permission_catalog_realm_types applicability
      JOIN community_type kind ON kind.id = applicability.type_id
      WHERE applicability.permissioncatalogentry_id = entity_permission_catalog.id ORDER BY kind.code) AS realm_types FROM entity_permission_catalog`,
  );
  const catalog = {};
  for (const row of rows) {
    catalog[row.code] = { scope: row.scope, is_active: row.is_active, realm_types: row.realm_types };
  }
  await _cacheSet(CATALOG_CACHE_KEY, JSON.stringify(catalog));
  return catalog;
}

async function getRoleMatrix(realmID) {
  const key = `${ROLE_MATRIX_CACHE_KEY}:${realmID}`;
  const cached = await _cacheGet(key);
  if (cached) {
    return JSON.parse(cached);
  }

  const { rows } = await pool.query(
    `
    SELECT rp.role_id, pce.code
    FROM entity_role_permissions rp
    JOIN entity_permission_catalog pce ON rp.permission_id = pce.id
    JOIN entity_role role ON role.id = rp.role_id
    WHERE role.realm_id = $1
    `, [realmID],
  );
  const matrix = {};
  for (const row of rows) {
    const roleID = String(row.role_id);
    if (!matrix[roleID]) matrix[roleID] = [];
    matrix[roleID].push(row.code);
  }
  await _cacheSet(key, JSON.stringify(matrix));
  return matrix;
}

async function getEntityTypeMatrix() {
  const cached = await _cacheGet(ENTITY_TYPE_MATRIX_CACHE_KEY);
  if (cached) {
    return JSON.parse(cached);
  }

  const { rows } = await pool.query(
    `
    SELECT et.name AS entity_type, pce.code
    FROM entity_permission_catalog_entity_types links
    JOIN entity_type et ON et.id = links.entity_type_id
    JOIN entity_permission_catalog pce ON pce.id = links.permission_id
    WHERE pce.is_active = true
    `,
  );
  const matrix = {};
  for (const row of rows) {
    if (!matrix[row.entity_type]) matrix[row.entity_type] = [];
    matrix[row.entity_type].push(row.code);
  }
  await _cacheSet(ENTITY_TYPE_MATRIX_CACHE_KEY, JSON.stringify(matrix));
  return matrix;
}

async function _getEntityType(entityId) {
  const { rows } = await pool.query(
    `SELECT type FROM entity_entity WHERE id = $1 LIMIT 1`,
    [entityId],
  );
  return rows.length > 0 ? rows[0].type : null;
}

async function _activeOverride(entityId, permission, realmId, client = pool) {
  const { rows } = await client.query(
    `
    SELECT ep.effect FROM entity_permission ep
    JOIN entity_permission_catalog pc ON pc.id = ep.permission_id
    WHERE ep.entity_id = $1
      AND pc.code = $2
      AND ep.realm_id IS NOT DISTINCT FROM $3
      AND (ep.expires_at IS NULL OR ep.expires_at > NOW())
    LIMIT 1
    `,
    [entityId, permission, realmId],
  );
  return rows.length > 0 ? rows[0].effect : null;
}

async function _globalPlatformDefault(entityId, client = pool) {
  // "Allowed unless explicitly denied" baseline - mirrors
  // entity/permissions.py::_account_in_good_standing.
  const { rows } = await client.query(
    `SELECT is_active FROM user_account WHERE entity_id = $1 LIMIT 1`,
    [entityId],
  );
  if (rows.length === 0) {
    // Non-user entities have no Account standing restriction, matching Django.
    return true;
  }
  return rows[0].is_active === true;
}

/**
 * hasPermission(entityId, permission, realmId = null) -> Promise<boolean>
 * realmId is the realm's identifier as used throughout this codebase's SQL
 * (community_realm.realm_id, which createRealmReusable always sets equal to
 * community_realm.id, the actual FK target of entity_permission.realm_id).
 */
async function rolePermission(roleID, permission, realmID, { client, fresh }) {
  if (roleID == null) return false;
  if (fresh) {
    const { rows } = await client.query(
      `SELECT rp.role_id, pce.code FROM entity_role_permissions rp
       JOIN entity_permission_catalog pce ON pce.id = rp.permission_id
       WHERE rp.role_id = $1 AND pce.code = $2 AND pce.is_active = TRUE`,
      [roleID, permission],
    );
    return rows.length > 0;
  }
  return (await getRoleMatrix(realmID))[String(roleID)]?.includes(permission) ?? false;
}

// Feature guards deny a disabled catalog capability; programming errors and
// unknown codes retain the generic resolver's explicit error contract.
async function hasActivePermission(entityId, permission, realmId = null, options = {}) {
  try { return await hasPermission(entityId, permission, realmId, options); }
  catch (error) {
    if (!error.message?.startsWith("Unknown permission string:")) throw error;
    const catalog = options.fresh ? Object.fromEntries((await (options.client || pool).query(
      `SELECT code, scope, is_active, ARRAY(SELECT kind.code
      FROM entity_permission_catalog_realm_types applicability
      JOIN community_type kind ON kind.id = applicability.type_id
      WHERE applicability.permissioncatalogentry_id = entity_permission_catalog.id ORDER BY kind.code) AS realm_types FROM entity_permission_catalog WHERE code = $1`, [permission],
    )).rows.map(row => [row.code, row])) : await getCatalog();
    if (catalog[permission] && !catalog[permission].is_active) return false;
    throw error;
  }
}

async function hasPermission(entityId, permission, realmId = null, { client = pool, fresh = false } = {}) {
  if (!entityId) {
    return false;
  }

  const catalog = fresh ? Object.fromEntries((await client.query(
    `SELECT code, scope, is_active, ARRAY(SELECT kind.code
      FROM entity_permission_catalog_realm_types applicability
      JOIN community_type kind ON kind.id = applicability.type_id
      WHERE applicability.permissioncatalogentry_id = entity_permission_catalog.id ORDER BY kind.code) AS realm_types FROM entity_permission_catalog WHERE code = $1`, [permission],
  )).rows.map(row => [row.code, row])) : await getCatalog();
  const entry = catalog[permission];
  if (!entry || !entry.is_active) {
    throw new Error(`Unknown permission string: ${permission}`);
  }

  const scope = entry.scope;
  if ((scope === "global" || scope === "entity_type") && realmId != null) {
    throw new Error(`${permission} is ${scope}-scoped and cannot take a realm`);
  }
  if (scope === "realm" && realmId == null) {
    throw new Error(`${permission} is realm-scoped and requires a realm`);
  }

  let role = null;
  if (realmId != null) {
    const { rows: realms } = await client.query(
      `SELECT id, entity_id, type, parent_id, is_active FROM community_realm WHERE id = $1 LIMIT 1`, [realmId]);
    const realm = realms[0];
    if (!realm?.is_active || !permissionApplies(entry, realm)) return false;
    if (realm.type !== 'community' && String(realm.entity_id) === String(entityId)) return true;
    const { rows } = await client.query(
      `SELECT m.role_id, r.code, r.is_default FROM community_member m
       JOIN entity_role r ON r.id = m.role_id AND r.realm_id = m.realm_id
       WHERE m.entity_id = $1 AND m.realm_id = $2 LIMIT 1`, [entityId, realmId]);
    role = rows[0];
    if (role?.is_default && role.code === "owner") return true;
  }
  const override = await _activeOverride(entityId, permission, realmId, client);
  if (override !== null) return override === "grant";
  if (scope === "entity_type") {
    const entityType = await _getEntityType(entityId);
    return (await getEntityTypeMatrix())[entityType]?.includes(permission) ?? false;
  }
  if (realmId != null) return rolePermission(role?.role_id, permission, realmId, { client, fresh });

  return GLOBAL_PLATFORM_DEFAULT.has(permission)
    ? _globalPlatformDefault(entityId, client)
    : false;
}

/**
 * resolveAllowedModulesAndContext(entityId, personalEntityId, personalProfile)
 * -> Promise<{ allowedModules, activeEntity }>
 *
 * Node-side port of Django's entity.services.allowed_modules
 * .resolve_allowed_modules_and_context() / entity.views.MyAllowedModules -
 * used directly by GET /auth/jwtchecker so session restore gets
 * allowed_modules/active_entity in the SAME response as the refreshed
 * usertoken, instead of a separate follow-up call to Django's
 * /api/entity/me/modules. Keep in sync with the Django version.
 *
 * entity_type-scoped codes are read straight from the shared catalog
 * (scope === "entity_type") rather than a hardcoded list here, unlike
 * Django's Permission.ENTITY_TYPE_SCOPED constant - the catalog is already
 * the single source of truth this file reads for everything else.
 */
async function resolveAllowedModulesAndContext(entityId, personalEntityId, personalProfile) {
  const catalog = await getCatalog();
  const entityTypeCodenames = Object.entries(catalog)
    .filter(([, entry]) => entry.scope === "entity_type" && entry.is_active)
    .map(([code]) => code);

  const allowedModules = [];
  for (const code of entityTypeCodenames) {
    if (await hasPermission(entityId, code, null)) {
      allowedModules.push(code);
    }
  }

  const isPersonal = entityId === personalEntityId;
  let activeEntity;

  if (isPersonal) {
    activeEntity = {
      id: entityId,
      type: "user",
      realm_type: null,
      realm_id: null,
      name: null,
      slug: null,
      profile: personalProfile,
    };
  } else {
    const { rows } = await pool.query(
      `SELECT id, type, name, slug, profile FROM community_realm WHERE entity_id = $1 LIMIT 1`,
      [entityId],
    );
    const realm = rows.length > 0 ? rows[0] : null;
    activeEntity = {
      id: entityId,
      type: "realm",
      realm_type: realm ? realm.type : null,
      realm_id: realm ? realm.id : null,
      name: realm ? realm.name : null,
      slug: realm ? realm.slug || realm.id : null,
      profile: realm ? realm.profile : null,
    };
  }

  return { allowedModules, activeEntity };
}

/**
 * requiresPermission(permission, { realmId }) - Express middleware factory,
 * used the same way as jwtchecker (reusables/hooks/jwthelper.js). Must run
 * after jwtchecker, since it reads req.params.entity_id.
 *
 * `realmId(req)`: optional callable resolving the realm identifier from the
 * request for realm-scoped permissions. Omit for global-scoped permissions.
 */
function requiresPermission(permission, { realmId } = {}) {
  return async (req, res, next) => {
    try {
      const entityId = req.params.entity_id;
      const realm = realmId ? realmId(req) : null;
      const allowed = await hasPermission(entityId, permission, realm);

      if (!allowed) {
        return res.status(403).send({
          status: false,
          message: `You do not have permission to perform this action (${permission}).`,
        });
      }

      next();
    } catch (err) {
      console.error(`Permission check failed for ${permission}:`, err);
      res.status(500).send({
        status: false,
        message: "Error checking permissions",
      });
    }
  };
}

module.exports = {
  hasPermission,
  hasActivePermission,
  requiresPermission,
  getCatalog,
  getRoleMatrix,
  getEntityTypeMatrix,
  resolveAllowedModulesAndContext,
};
