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
 * Every command usable in one conversation.
 *
 * THE SAME REACH RULE AS RESOLVE_SQL, AND THAT IS THE POINT
 * ---------------------------------------------------------
 * The menu and the parser have to agree. A command offered here that then
 * refused to run, or one that runs but was never offered, is the same bug
 * seen from two ends - so both clauses are written once, here, and differ
 * only in that this one is not narrowed to a single name or target.
 *
 * THE LIST IS DERIVED, NEVER STORED
 * ---------------------------------
 * Computed from the participants on every call, so a bot removed from the
 * conversation takes its commands with it and one added brings its own. There
 * is nothing to invalidate, and no way for the menu to outlive the membership
 * it was built from.
 *
 * A SYSTEM BOT IS ALWAYS IN THE ROOM
 * ----------------------------------
 * `/members` and `/help` work everywhere without the System bot being a
 * participant anywhere - it cannot be added to a conversation, or searched
 * for, or removed. `b.is_system` is what makes it a member of every
 * conversation for this purpose and none of them for any other.
 */
const LIST_SQL = `
  SELECT c.name,
         c.description,
         c.responds,
         b.handle    AS bot_handle,
         b.name      AS bot_name,
         b.is_system AS bot_is_system
    FROM bot_commands c
    JOIN bot_bot b ON b.id = c.bot_id
   WHERE c.is_active
     AND b.is_active
     AND (b.is_system OR b.entity_id = ANY($1::text[]))
   ORDER BY b.is_system DESC, lower(c.name), lower(b.handle)`;

/**
 * @param {string[]} participantEntityIds  the conversation's members
 * @returns {Promise<Array<object>>}  the menu, already public-shaped
 */
const listCommands = async (participantEntityIds = []) => {
  const participants = [
    ...new Set((participantEntityIds || []).filter(Boolean).map(String)),
  ];

  const { rows } = await pool.query(LIST_SQL, [participants]);
  return publicCommandList(rows);
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

/**
 * The menu, with the text to insert worked out per entry.
 *
 * WHY THE SERVER DECIDES WHAT TO INSERT
 * -------------------------------------
 * Two bots can each own a "summarize". Combining their lists puts both in one
 * menu, and a client that inserted the bare "/summarize" would run BOTH -
 * which is the precise ambiguity the `:handle` suffix exists to remove.
 *
 * So `insert` is computed here: the bare name while it is unique in THIS
 * conversation, and the targeted form the moment it is not. Doing it per
 * conversation rather than globally matters - it means a name shared across
 * the platform still inserts cleanly in a room with only one of its owners in
 * it, and every client gets the rule right without implementing it.
 */
const publicCommandList = (rows = []) => {
  const seen = new Map();
  for (const row of rows) {
    const name = String(row.name || "").toLowerCase();
    seen.set(name, (seen.get(name) || 0) + 1);
  }

  return rows.map((row) => {
    const command = publicCommand(row);
    const ambiguous = (seen.get(String(row.name || "").toLowerCase()) || 0) > 1;
    return {
      ...command,
      // The bot's display name, so a menu can show who owns a command without
      // a second lookup per row.
      bot_name: row.bot_name || row.bot_handle || "",
      is_system: Boolean(row.bot_is_system),
      insert:
        ambiguous && row.bot_handle
          ? `/${row.name}:${row.bot_handle}`
          : `/${row.name}`,
    };
  });
};

module.exports = {
  resolveCommand,
  listCommands,
  publicCommand,
  publicCommandList,
  RESOLVE_SQL,
  LIST_SQL,
};
