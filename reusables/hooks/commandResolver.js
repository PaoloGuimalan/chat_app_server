/**
 * Turning a parsed `/command` into the bots that should run it.
 *
 * REACH IS THE BOT
 * ----------------
 * A command is usable exactly where its bot is. An ordinary bot reaches the
 * conversations it is a member of; a system bot is exempt and reaches
 * everywhere. There is no scope column to consult, so this is the only place
 * that decides reach - and it decides it from the participant list the send
 * path already holds.
 *
 * ONE QUERY, ONLY WHEN THERE IS A SLASH
 * -------------------------------------
 * The caller parses first and calls this only when a command was found, so an
 * ordinary message costs nothing. When there is one, this is a single indexed
 * lookup on `name` with the participants passed in - not a scan, and not a
 * round trip per bot.
 *
 * NOTHING MATCHING IS NORMAL
 * --------------------------
 * A typo, a command that belongs to a bot that is not here, a target naming a
 * bot without that command - all resolve to an empty list and the message
 * stays ordinary text. That is one code path for "misspelled" and "not
 * available here", which is why neither needs an error.
 */

const pool = require("../database/postgres");

/**
 * Commands with this name that are reachable in this conversation.
 *
 * `$2` is the participants' entity ids; a system bot ignores them. `$3` is an
 * optional handle from `/name:target`, which narrows to one bot.
 */
const RESOLVE_SQL = `
  SELECT c.id,
         c.name,
         c.description,
         c.category,
         c.responds,
         c.webhook_url,
         c.webhook_request,
         b.id         AS bot_id,
         b.entity_id  AS bot_entity_id,
         b.handle     AS bot_handle,
         b.is_system  AS bot_is_system
    FROM bot_commands c
    JOIN bot_bot b ON b.id = c.bot_id
   WHERE c.is_active
     AND b.is_active
     AND lower(c.name) = $1
     AND (b.is_system OR b.entity_id = ANY($2::text[]))
     AND ($3::text IS NULL OR lower(b.handle) = $3)
   ORDER BY b.is_system DESC, lower(b.handle)`;

/**
 * @param {{name: string, target: string|null}} command  from parseCommand
 * @param {string[]} participantEntityIds  the conversation's members
 * @returns {Promise<Array<object>>}  one row per bot that should run it
 */
const resolveCommand = async (command, participantEntityIds = []) => {
  if (!command || !command.name) return [];

  const participants = [
    ...new Set((participantEntityIds || []).filter(Boolean).map(String)),
  ];

  const { rows } = await pool.query(RESOLVE_SQL, [
    String(command.name).toLowerCase(),
    participants,
    command.target ? String(command.target).toLowerCase() : null,
  ]);

  return rows;
};

/**
 * What the client may be told, for autocomplete.
 *
 * An ALLOW-list rather than deleting the dangerous fields, so a column added
 * later is private by default. `webhook_url` and `webhook_request` never leave
 * the server - the latter carries credentials in plain text, since an
 * Authorization header lives in it.
 */
const publicCommand = (row) => ({
  name: row.name,
  description: row.description,
  responds: row.responds,
  bot: row.bot_handle,
});

module.exports = { resolveCommand, publicCommand, RESOLVE_SQL };
