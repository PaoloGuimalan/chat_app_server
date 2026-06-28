// Cross-DB entity resolution for the messaging layer.
//
// Sender/participants are entity ids (entity:user:<id> / entity:realm:<realm_id>).
// These helpers hydrate entity ids into displayable rows (from Postgres) and
// expand them into the flat list of *human* recipients used for delivery
// (Redis is per-human: events_<userID>).

const pool = require("../../reusables/database/postgres");
const Conversation = require("../../schema/messages/conversation");
const makeid = require("../hooks/makeID");
const {
  parseEntityId,
  userEntity,
  realmEntity,
  normalizeSender,
} = require("../hooks/entity");

// entityIds -> { [entityId]: { entity_id, entity_type, display } }
// display is the existing user/realm preview shape so callers can render it.
const resolveEntities = async (entityIds) => {
  const ids = [...new Set((entityIds || []).map(normalizeSender).filter(Boolean))];
  const userSourceIds = [];
  const realmSourceIds = [];
  for (const eid of ids) {
    const { type, sourceId } = parseEntityId(eid);
    if (type === "user") userSourceIds.push(sourceId);
    else if (type === "realm") realmSourceIds.push(sourceId);
  }

  const out = {};

  if (userSourceIds.length > 0) {
    const { rows } = await pool.query(
      "SELECT id, username, first_name, last_name, middle_name, profile, is_badged FROM user_account WHERE id = ANY($1::text[]);",
      [userSourceIds],
    );
    for (const r of rows) {
      out[userEntity(r.id)] = {
        entity_id: userEntity(r.id),
        entity_type: "user",
        display: r,
      };
    }
  }

  if (realmSourceIds.length > 0) {
    const { rows } = await pool.query(
      "SELECT id, realm_id, name, profile, type, is_verified, slug FROM community_realm WHERE realm_id = ANY($1::text[]);",
      [realmSourceIds],
    );
    for (const r of rows) {
      out[realmEntity(r.realm_id)] = {
        entity_id: realmEntity(r.realm_id),
        entity_type: "realm",
        display: r,
      };
    }
  }

  return out;
};

// Expand entity participants into the flat human recipients for delivery:
// a user entity -> that account; a realm entity -> all its members.
const expandEntitiesToDeliveryUsers = async (entityIds) => {
  const ids = [...new Set((entityIds || []).map(normalizeSender).filter(Boolean))];
  const userSourceIds = [];
  const realmSourceIds = [];
  for (const eid of ids) {
    const { type, sourceId } = parseEntityId(eid);
    if (type === "user") userSourceIds.push(sourceId);
    else if (type === "realm") realmSourceIds.push(sourceId);
  }

  const byId = new Map();

  if (userSourceIds.length > 0) {
    const { rows } = await pool.query(
      "SELECT id, username FROM user_account WHERE id = ANY($1::text[]);",
      [userSourceIds],
    );
    for (const r of rows) byId.set(r.id, { userID: r.id, username: r.username });
  }

  if (realmSourceIds.length > 0) {
    const { rows } = await pool.query(
      "SELECT ua.id, ua.username FROM community_member cm JOIN entity e ON e.entity_id = cm.actor_entity_id JOIN user_account ua ON ua.id = e.account_id WHERE cm.realm_id = ANY($1::text[]);",
      [realmSourceIds],
    );
    for (const r of rows) byId.set(r.id, { userID: r.id, username: r.username });
  }

  return [...byId.values()];
};

// Find (or create) the 1:1 conversation between exactly two entities.
// Identity is a generated conversationID + stored participant_entity_ids
// (per the chosen design), with a lookup to prevent duplicate threads.
const findOrCreateEntityDM = async (entityA, entityB) => {
  const a = normalizeSender(entityA);
  const b = normalizeSender(entityB);
  if (!a || !b) throw new Error("two entity ids are required");
  const pair = [a, b].sort();

  // Match a single-type conversation whose entity participants are exactly this pair.
  const existing = await Conversation.findOne({
    conversationType: "single",
    participant_entity_ids: { $all: pair, $size: pair.length },
  });
  if (existing) return existing;

  const conversation = new Conversation({
    conversationID: makeid(30),
    conversationType: "single",
    participant_entity_ids: pair,
  });
  await conversation.save();
  return conversation;
};

module.exports = {
  resolveEntities,
  expandEntitiesToDeliveryUsers,
  findOrCreateEntityDM,
};
