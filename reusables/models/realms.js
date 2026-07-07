const pool = require("../database/postgres");
const { AddNewMemberToContacts } = require("./messages");
const Conversations = require("../../schema/messages/conversation");

const isRealmMember = async (realm_id, entity_id) => {
  const { rows: realm_row } = await pool.query(
    `SELECT * FROM community_realm WHERE realm_id = $1`,
    [realm_id],
  );

  if (realm_row.length > 0) {
    const realm = realm_row[0];

    if (realm.type === "conference" && !realm.is_private) {
      await AddNewMemberToContacts(realm_id, entity_id, entity_id);
    }

    // A page's own entity can never appear as a Member row of its own
    // realm (community_member only ever holds personal accounts) - so
    // once switched to act as this exact realm, the lookup below would
    // always miss and wrongly deny access to its own conversation/realm.
    if (realm.entity_id === entity_id) {
      return;
    }

    const { rows: is_member } = await pool.query(
      `SELECT member_id FROM community_member WHERE entity_id = $1 AND realm_id = $2;`,
      [entity_id, realm_id],
    );

    if (is_member.length <= 0) {
      throw new Error("You do not have access to this conversation");
    }
    return;
  }

  // Not a realm - this is a single/DM conversation. Some are backed by a
  // user_connection row (the normal "add contact" flow), but not all -
  // some conversations only ever exist as a Mongo Conversations doc with
  // participant_ids and were never a Connection, so either can prove
  // entity_id is actually a party to it.
  const [connectionRows, mongoConversation] = await Promise.all([
    pool.query(
      `SELECT 1 FROM user_connection WHERE connection_id = $1 AND (action_by_id = $2 OR involved_entity_id = $2) LIMIT 1`,
      [realm_id, entity_id],
    ),
    Conversations.findOne({
      conversationID: realm_id,
      participant_ids: entity_id,
    }),
  ]);

  if (connectionRows.rows.length === 0 && mongoConversation === null) {
    throw new Error("You do not have access to this conversation");
  }
};

const isRealmPublic = async (realm_id) => {
  const { rows: realm_row } = await pool.query(
    `SELECT * FROM community_realm WHERE realm_id = $1`,
    [realm_id],
  );

  if (realm_row.length > 0) {
    const realm = realm_row[0];

    return !realm.is_private;
  }

  return false;
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
  isRealmPublic,
};
