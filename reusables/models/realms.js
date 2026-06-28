const pool = require("../database/postgres");
const { AddNewMemberToContacts } = require("./messages");
const { canUserActAsEntity, resolveUserEntity } = require("./entities");

const isRealmMember = async (realm_id, user_id, sender_entity_id = null) => {
  const userEntity = await resolveUserEntity(user_id).catch(() => null);
  if (!userEntity?.id) {
    throw new Error("Entity profile not found for user");
  }
  const memberAccountIDs = [String(userEntity.id)];

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
      `
        SELECT member_id
        FROM community_member
        WHERE account_id = ANY($1::text[])
          AND realm_id = $2;
      `,
      [memberAccountIDs, realm_id],
    );

    if (is_member.length > 0) {
      return true;
    }

    if (sender_entity_id) {
      const actingAllowed = await canUserActAsEntity({
        userID: user_id,
        entityID: sender_entity_id,
      });

      if (actingAllowed) {
        const { rows: entity_member } = await pool.query(
          `
            SELECT 1
            FROM community_member cm
            WHERE cm.realm_id = $1
              AND cm.nickname = $2
            LIMIT 1;
          `,
          [realm_id, sender_entity_id],
        );

        if (entity_member.length > 0) {
          return true;
        }
      }
    }

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
  }
};

module.exports = {
  isRealmMember,
  GetRealmName,
};
