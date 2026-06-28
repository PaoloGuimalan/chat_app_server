// Deterministic entity-id resolver — JS mirror of the canonical Python helper
// (entity/services.py / entity/models.py) and the TS mirror
// (webapp/src/reusables/hooks/entity.ts). The format string lives ONLY in these
// three files; everything else calls these helpers.
//
// Format: entity:<type>:<source_id>
//   entity:user:<account.id>       (uuid)
//   entity:realm:<realm.realm_id>  (15-digit business key)

const ENTITY_TYPE_USER = "user";
const ENTITY_TYPE_REALM = "realm";

function buildEntityId(entityType, sourceId) {
  return `entity:${String(entityType).trim().toLowerCase()}:${sourceId}`;
}

function userEntity(accountId) {
  return buildEntityId(ENTITY_TYPE_USER, accountId);
}

function realmEntity(realmId) {
  return buildEntityId(ENTITY_TYPE_REALM, realmId);
}

// Returns { type, sourceId } or { type: null, sourceId: null } if malformed.
// sourceId may itself contain colons, so we split with a limit of 3 parts.
function parseEntityId(entityId) {
  if (!entityId || typeof entityId !== "string") {
    return { type: null, sourceId: null };
  }
  const idx1 = entityId.indexOf(":");
  if (idx1 === -1 || entityId.slice(0, idx1) !== "entity") {
    return { type: null, sourceId: null };
  }
  const idx2 = entityId.indexOf(":", idx1 + 1);
  if (idx2 === -1) {
    return { type: null, sourceId: null };
  }
  return {
    type: entityId.slice(idx1 + 1, idx2),
    sourceId: entityId.slice(idx2 + 1),
  };
}

function isEntityId(value) {
  return typeof value === "string" && value.startsWith("entity:");
}

// Back-compat: legacy Mongo records store a bare user-id string in `sender`
// and `participant_ids`. Treat any non-entity value as a user entity so
// readers can compare uniformly against entity ids.
function normalizeSender(value) {
  if (value == null) return value;
  return isEntityId(value) ? value : userEntity(value);
}

module.exports = {
  ENTITY_TYPE_USER,
  ENTITY_TYPE_REALM,
  buildEntityId,
  userEntity,
  realmEntity,
  parseEntityId,
  isEntityId,
  normalizeSender,
};
