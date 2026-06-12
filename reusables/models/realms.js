const pool = require("../database/postgres");

const isRealmMember = async (realm_id, user_id) => {
  const { rows: realm_row } = await pool.query(
    `SELECT * FROM community_realm WHERE realm_id = $1`,
    [realm_id],
  );

  if (realm_row.length > 0) {
    const { rows: is_member } = await pool.query(
      `SELECT member_id FROM community_member WHERE account_id = $1 AND realm_id = $2;`,
      [user_id, realm_id],
    );

    if (is_member.length <= 0) {
      throw new Error("You do not have access to this conversation");
    }
  }
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
  GetRealmName,
};
