/**
 * Node-side port of the entity permissions system defined in the Django
 * user_service repo (entity/permissions.py, entity/services/permission_resolver.py).
 * Both repos share the same Postgres tables (entity_entitypermission,
 * community_member, entity_permissioncatalogentry, entity_rolepermission),
 * so this hand-ports the same priority logic rather than calling into
 * Django - keep the two files in sync when either changes:
 *   - user_service/entity/permissions.py
 *   - user_service/entity/services/permission_resolver.py
 *   - user_service/entity/services/permission_catalog_cache.py
 *
 * The permission catalog, role-default matrix, and entity-type-default
 * matrix are DATABASE-BACKED (entity_permissioncatalogentry,
 * entity_rolepermission, entity_entitytypedefaultpermission), not hardcoded
 * here - both repos read the same shared Redis instance
 * (permcache:catalog:v1 / permcache:role_matrix:v1 /
 * permcache:entity_type_matrix:v1, plain JSON strings) with a direct-query
 * fallback on a cache miss, so an admin editing the catalog on the Django
 * side is visible here without a deploy.
 *
 * Resolution priority (highest to lowest):
 *   1. Explicit deny (entity_entitypermission, effect='deny', not expired) -> false, always.
 *   2. Explicit grant (effect='grant', not expired) -> true.
 *   3. Entity-type default (entity_type-scoped) OR role-derived default
 *      (realm-scoped) OR platform default (global-scoped).
 *   4. Deny-by-default fallback -> false.
 */

const redis = require("redis");
const pool = require("../database/postgres");
const { REDIS_HOST, REDIS_PORT, REDIS_USERNAME, REDIS_PASSWORD } = require("../vars/redis");

const CATALOG_CACHE_KEY = "permcache:catalog:v1";
const ROLE_MATRIX_CACHE_KEY = "permcache:role_matrix:v1";
const ENTITY_TYPE_MATRIX_CACHE_KEY = "permcache:entity_type_matrix:v1";
const CACHE_TTL_SECONDS = 60 * 60; // safety-net only; Django invalidates on write

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
    `SELECT codename, scope, is_active FROM entity_permissioncatalogentry`,
  );
  const catalog = {};
  for (const row of rows) {
    catalog[row.codename] = { scope: row.scope, is_active: row.is_active };
  }
  await _cacheSet(CATALOG_CACHE_KEY, JSON.stringify(catalog));
  return catalog;
}

async function getRoleMatrix() {
  const cached = await _cacheGet(ROLE_MATRIX_CACHE_KEY);
  if (cached) {
    return JSON.parse(cached);
  }

  const { rows } = await pool.query(
    `
    SELECT rp.role, pce.codename
    FROM entity_rolepermission rp
    JOIN entity_permissioncatalogentry pce ON rp.permission_id = pce.id
    WHERE pce.is_active = true
    `,
  );
  const matrix = {};
  for (const row of rows) {
    if (!matrix[row.role]) matrix[row.role] = [];
    matrix[row.role].push(row.codename);
  }
  await _cacheSet(ROLE_MATRIX_CACHE_KEY, JSON.stringify(matrix));
  return matrix;
}

async function getEntityTypeMatrix() {
  const cached = await _cacheGet(ENTITY_TYPE_MATRIX_CACHE_KEY);
  if (cached) {
    return JSON.parse(cached);
  }

  const { rows } = await pool.query(
    `
    SELECT etp.entity_type, pce.codename
    FROM entity_entitytypedefaultpermission etp
    JOIN entity_permissioncatalogentry pce ON etp.permission_id = pce.id
    WHERE pce.is_active = true
    `,
  );
  const matrix = {};
  for (const row of rows) {
    if (!matrix[row.entity_type]) matrix[row.entity_type] = [];
    matrix[row.entity_type].push(row.codename);
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

async function _activeOverride(entityId, permission, realmId) {
  const { rows } = await pool.query(
    `
    SELECT effect FROM entity_entitypermission
    WHERE entity_id = $1
      AND permission = $2
      AND realm_id IS NOT DISTINCT FROM $3
      AND (expires_at IS NULL OR expires_at > NOW())
    LIMIT 1
    `,
    [entityId, permission, realmId],
  );
  return rows.length > 0 ? rows[0].effect : null;
}

async function _globalPlatformDefault(entityId) {
  // "Allowed unless explicitly denied" baseline - mirrors
  // entity/permissions.py::_account_in_good_standing.
  const { rows } = await pool.query(
    `SELECT is_active FROM user_account WHERE entity_id = $1 LIMIT 1`,
    [entityId],
  );
  if (rows.length === 0) {
    // Non-user entities (realm/bot) have no Account row - fall through to
    // explicit grant/deny only, same as the Django side.
    return true;
  }
  return rows[0].is_active === true;
}

/**
 * hasPermission(entityId, permission, realmId = null) -> Promise<boolean>
 * realmId is the realm's identifier as used throughout this codebase's SQL
 * (community_realm.realm_id, which createRealmReusable always sets equal to
 * community_realm.id, the actual FK target of entity_entitypermission.realm_id).
 */
async function hasPermission(entityId, permission, realmId = null) {
  if (!entityId) {
    return false;
  }

  const catalog = await getCatalog();
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

  const override = await _activeOverride(entityId, permission, realmId);
  if (override !== null) {
    return override === "grant";
  }

  if (scope === "entity_type") {
    const entityType = await _getEntityType(entityId);
    const entityTypeMatrix = await getEntityTypeMatrix();
    const allowedForType = entityType ? entityTypeMatrix[entityType] : null;
    return allowedForType ? allowedForType.includes(permission) : false;
  }

  if (realmId != null) {
    // A page's own entity can never appear as a Member row of its own realm
    // (community_member only ever holds personal accounts), so once "acting
    // as" that exact page (entity switch re-issues the JWT's entity claim to
    // the realm's own entity), the Member lookup below would always miss and
    // wrongly deny. Resolve self-administration as owner tier directly -
    // this can only match the realm this entity's own id belongs to, so it
    // can't be used to bypass authorization on any other realm.
    const { rows: selfRealmRows } = await pool.query(
      `SELECT 1 FROM community_realm WHERE realm_id = $1 AND entity_id = $2 LIMIT 1`,
      [realmId, entityId],
    );
    if (selfRealmRows.length > 0) {
      const roleMatrix = await getRoleMatrix();
      const ownerDefaults = roleMatrix["owner"];
      return ownerDefaults ? ownerDefaults.includes(permission) : false;
    }

    const { rows } = await pool.query(
      `SELECT role FROM community_member WHERE entity_id = $1 AND realm_id = $2 LIMIT 1`,
      [entityId, realmId],
    );
    if (rows.length === 0) {
      return false;
    }
    const roleMatrix = await getRoleMatrix();
    const roleDefaults = roleMatrix[rows[0].role];
    return roleDefaults ? roleDefaults.includes(permission) : false;
  }

  return _globalPlatformDefault(entityId);
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
  requiresPermission,
  getCatalog,
  getRoleMatrix,
  getEntityTypeMatrix,
};
