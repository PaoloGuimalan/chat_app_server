/**
 * Who is entitled to see whose "Active Now" dot.
 *
 * SECOND IMPLEMENTATION, AND WHY THAT IS TOLERABLE
 * -----------------------------------------------
 * This query also exists in Go, at
 * chatterloop_services/developer_service/internal/presence/scope.go. Two
 * copies of one rule is normally a bad smell, and the thing that makes it
 * survivable here is that they answer for DIFFERENT halves of the same
 * contract and neither could reasonably own both:
 *
 *   - THIS one backs the `/u/activecontacts` snapshot a client pulls on boot.
 *     It is a REST route on this service; nothing else can serve it.
 *   - THE GO one backs the `active_users` push a client receives afterwards,
 *     for entities that connect to developer_service rather than here.
 *
 * They must agree. If the pull were wider than the push, dots would light on
 * load and then silently stop updating; narrower, and a dot would appear from
 * nowhere on the first change. Keep the two in step - the SQL is deliberately
 * identical text, and the Go side carries the same comment pointing back here.
 */

const pool = require("../database/postgres");
const Conversations = require("../../schema/messages/conversation");

/**
 * Every entity whose online state this one may see - and, read the other way,
 * everyone who must be told when THIS entity connects or disconnects.
 *
 * TWO SOURCES, UNIONED, because either alone is wrong:
 *
 *  - CONTACTS. You can be connected to someone you have never messaged, and
 *    their dot should still light up in the contacts list.
 *  - DM COUNTERPARTS. You can share a conversation with someone who is not a
 *    contact at all. Not an edge case: a bot CANNOT be a contact (can_connect
 *    is false for every one, so no entity_connection row is ever written), and
 *    a DM with one exists only as a Mongo conversation document.
 *
 * That second source is why bots and pages have never had a dot. Not because
 * presence was withheld from them - because the scope was contacts-only, so
 * nobody was ever in scope to be told, and the snapshot never asked about them.
 *
 * ENTITY-GENERIC, which the contacts half previously was not: it joined
 * user_account on BOTH sides, dropping a page or bot counterpart before the
 * query returned. The visibility rule now mirrors the platform's own
 * (user_service entity/utils.py entity_side_is_visible): a user must be active
 * AND verified, a realm or bot only active - `is_verified` on those two is the
 * display BADGE, not an access gate, and requiring it would hide every
 * unbadged page.
 *
 * GROUP CO-MEMBERS ARE DELIBERATELY EXCLUDED. They share a conversation in the
 * literal sense, but a group header renders the static string "Members are
 * Active" rather than a per-entity dot, so including them would buy no visible
 * change while turning one connect in a 500-member server into 500 published
 * frames. Add a UNION arm here if a member list ever grows real per-row
 * presence.
 */
const getPresenceScope = async (entity_id) => {
  // The counterpart is resolved once in the CASE and reused, rather than
  // re-derived per row afterwards, so the active/verified filter applies to
  // the counterpart rather than to whichever side happens to be listed first.
  const contactsSql = `
    SELECT DISTINCT
      CASE WHEN c.action_by_id = $1 THEN c.involved_entity_id
           ELSE c.action_by_id END AS counterpart_id
    FROM entity_connection c
    JOIN entity_entity p
      ON p.id = CASE WHEN c.action_by_id = $1 THEN c.involved_entity_id
                     ELSE c.action_by_id END
    LEFT JOIN user_account   u ON u.entity_id = p.id AND p.type = 'user'
    LEFT JOIN community_realm r ON r.entity_id = p.id AND p.type = 'realm'
    LEFT JOIN bot_bot         b ON b.entity_id = p.id AND p.type = 'bot'
    WHERE
      (c.action_by_id = $1 OR c.involved_entity_id = $1)
      AND c.action_by_id <> c.involved_entity_id
      AND c.status = TRUE
      AND COALESCE(u.is_active, r.is_active, b.is_active, FALSE) = TRUE
      -- Users only: a NULL u row (page/bot) makes this TRUE and passes.
      AND COALESCE(u.is_verified, TRUE) = TRUE;
  `;

  const scope = new Set();

  try {
    const { rows } = await pool.query(contactsSql, [entity_id]);
    rows.forEach((row) => {
      if (row.counterpart_id) scope.add(String(row.counterpart_id));
    });
  } catch (err) {
    console.log("[getPresenceScope] contacts query failed", err);
  }

  // Single conversations only - see the group note above. `participant_ids` is
  // indexed (schema/messages/conversation.js), so this is a covered lookup
  // rather than a scan.
  try {
    const conversations = await Conversations.find(
      { conversationType: "single", participant_ids: String(entity_id) },
      { participant_ids: 1, _id: 0 },
    ).lean();

    conversations.forEach((conversation) => {
      (conversation.participant_ids || []).forEach((participant) => {
        const id = String(participant);
        if (id && id !== String(entity_id)) scope.add(id);
      });
    });
  } catch (err) {
    console.log("[getPresenceScope] conversation query failed", err);
  }

  scope.delete(String(entity_id));
  return [...scope];
};

module.exports = {
  getPresenceScope,
};
