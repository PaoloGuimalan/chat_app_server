const pool = require("../database/postgres");
const { AddNewMemberToContacts } = require("./messages");

const isRealmMember = async (realm_id, user_id) => {
  const { rows: realm_row } = await pool.query(
    `SELECT * FROM community_realm WHERE realm_id = $1`,
    [realm_id],
  );

  if (realm_row.length > 0) {
    const realm = realm_row[0];

    if (realm.type === "conference" && !realm.is_private) {
      await AddNewMemberToContacts(realm_id, user_id, user_id);
    }

    const { rows: is_member } = await pool.query(
      `SELECT member_id FROM community_member WHERE actor_entity_id = 'entity:user:' || $1 AND realm_id = $2;`,
      [user_id, realm_id],
    );

    if (is_member.length <= 0) {
      throw new Error("You do not have access to this conversation");
    }
  }
};

// Roles allowed to act on behalf of a realm. Mirrors the Django
// ELIGIBLE_ACT_AS_ROLES (entity/services.py). Realm-type-agnostic.
const ELIGIBLE_ACT_AS_ROLES = ["admin", "owner", "creator"];

// Node-side re-validation of an act-as request (never trust the client):
// the realm creator is always eligible, else the account must hold an
// eligible membership role. Works for any realm.type.
const canActAsRealm = async (realmRef, account_id) => {
  // realmRef may be the realm's slug (profile key) or its realm_id.
  const { rows: realm_row } = await pool.query(
    `SELECT realm_id, created_by_id FROM community_realm WHERE realm_id = $1 OR slug = $1`,
    [realmRef],
  );
  if (realm_row.length === 0) return false;
  const realm = realm_row[0];
  if (String(realm.created_by_id) === String(account_id)) return true;

  const { rows } = await pool.query(
    `SELECT 1 FROM community_member WHERE actor_entity_id = 'entity:user:' || $1 AND realm_id = $2 AND role = ANY($3::text[]) LIMIT 1;`,
    [account_id, realm.realm_id, ELIGIBLE_ACT_AS_ROLES],
  );
  return rows.length > 0;
};

const GetRealmName = async (realm_id) => {
  const { rows: realm_row } = await pool.query(
    `SELECT * FROM community_realm WHERE realm_id = $1`,
    [realm_id],
  );

  if (realm_row.length > 0) {
    const realm = realm_row[0];

    if (realm.parent_id) {
      const parentName = await GetRealmName(realm.parent_id);

      return `${parentName} | ${realm.name}`;
    }

    return realm.name;

    if (is_member.length <= 0) {
      throw new Error("You do not have access to this conversation");
    }
  }
};

module.exports = {
  isRealmMember,
  canActAsRealm,
  GetRealmName,
};
