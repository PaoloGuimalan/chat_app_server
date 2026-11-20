// Keep aligned with entity/services/permission_applicability.py.
const REALM_TYPES = Object.freeze(['channel', 'community', 'conference', 'group', 'page', 'server', 'voice']);

function effectiveRealmKind(realm) {
  return realm?.type === 'group' && realm.parent_id ? 'channel' : realm?.type;
}
function permissionApplies(entry, realm) {
  if (entry?.scope !== 'realm') return true;
  const types = entry.realm_types;
  return Array.isArray(types) && types.length > 0 &&
    types.every(kind => typeof kind === 'string' && REALM_TYPES.includes(kind)) &&
    types.includes(effectiveRealmKind(realm));
}

/** Internal SQL aliases only; the database relation is the source of truth. */
function realmPermissionSQL(permission, realm) {
  if (![permission, realm].every(alias => /^[a-z_][a-z0-9_]*$/i.test(alias))) throw new TypeError('Invalid applicability alias');
  return `EXISTS (SELECT 1 FROM entity_permission_catalog_realm_types applicability
    JOIN community_type realm_kind ON realm_kind.id = applicability.type_id
    WHERE applicability.permissioncatalogentry_id = ${permission}.id
      AND realm_kind.code = CASE WHEN ${realm}.type = 'group' AND ${realm}.parent_id IS NOT NULL
        THEN 'channel' ELSE ${realm}.type END)`;
}
module.exports = { effectiveRealmKind, permissionApplies, realmPermissionSQL };
