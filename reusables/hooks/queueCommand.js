/**
 * Hand one `/command` to worker_service.
 *
 * SYSTEM AND WEBHOOK ONLY
 * -----------------------
 * Those two are the platform's to run, so they go to worker_service - where
 * the retries, timeouts and concurrency limits already live.
 *
 * BOT commands are not queued at all. A bot already receives a frame for every
 * message in its conversations, and that frame now carries the command that
 * was typed, so a bot learns about one the same way it learns about a mention.
 * Whether it HAS that command, and what it does about it, is the bot's
 * business - chatterloop does not need to know, and a row here exists only so
 * the command can be listed for autocomplete.
 *
 * THE JOB CARRIES AN ID, NOT THE DEFINITION
 * -----------------------------------------
 * `webhook_request` holds credentials in plain text - an Authorization header
 * lives in it - so putting the row on the queue would put them in the broker,
 * in its logs, and in any dead-letter queue they land in. The worker loads the
 * row itself, which also means it runs the CURRENT definition rather than a
 * snapshot taken before it was edited.
 *
 * NEVER AWAITED, NEVER THROWS
 * ---------------------------
 * The same contract as queueMessageTagging in models/messages.js: sending a
 * message must not wait on, or fail because of, what the message triggers.
 */

const {
  parseCommands,
  overflowCommands,
  MAX_COMMANDS_PER_MESSAGE,
} = require("./commandParser");
const { postSystemNotice } = require("./systemNotice");
const { resolveCommand } = require("./commandResolver");
const { buildEnvelope } = require("./commandEnvelope");
const { publish, QUEUES } = require("../rabbitmq/workqueue");

/**
 * @returns {Promise<number>} how many jobs were queued, across every command
 *   in the message and every bot each one resolves to. 0 is the ordinary
 *   answer - most messages are not commands.
 */
const queueCommand = async ({
  command,
  messageID,
  conversationID,
  conversationType,
  sender,
  senderHandle,
  content,
  messageType,
  replyingTo,
  participants = [],
}) => {
  try {
    // Only text carries a command. An image with a caption starting "/" is a
    // caption, and "notif" is a string this server wrote.
    if (String(messageType).toLowerCase() !== "text") return 0;

    // EVERY command in the message, not just the first. "/wake:neon
    // /wake:xenon" is one thought - wake both - and running only the first
    // was a message that visibly contained two commands doing half of what it
    // said.
    //
    // The caller passes the one it parsed for the realtime frame, which
    // carries a single command; that is used as the first rather than parsing
    // twice, so the frame and the queue cannot disagree about what was typed.
    const parsed = parseCommands(content);
    if (!parsed.length) return 0;
    if (command && parsed[0]) {
      parsed[0] = { ...parsed[0], ...command };
    }

    let queued = 0;

    for (const typed of parsed) {
      const resolved = await resolveCommand(typed, participants);

      // Bot commands are the bot's own business - see the module docstring.
      const rows = resolved.filter(
        (row) => row.category === "system" || row.category === "webhook",
      );
      if (!rows.length) {
        // A typo, a command whose bot is not here, a target naming a bot
        // without it, or one that is a bot's to run. All the same here:
        // nothing to queue for THIS command, and the next one still gets its
        // turn.
        continue;
      }

      // Its own envelope, carrying its own name, target and arguments. One
      // shared envelope would tell every job it was the first command.
      const envelope = buildEnvelope({
        command: typed,
        messageID,
        conversationID,
        conversationType,
        sender,
        senderHandle,
        replyingTo,
      });

      // One job per bot. Fan-out is resolved HERE rather than in the worker,
      // so a slow or failing bot cannot hold up the others.
      for (const row of rows) {
        const ok = await publish(QUEUES.RUN_COMMAND, {
          command_id: row.id,
          envelope,
        });
        if (ok) queued += 1;
      }
    }

    // What the cap dropped, said out loud. A message that visibly contains
    // eight commands and quietly runs five is indistinguishable from three of
    // them failing, and nothing in the conversation tells the difference.
    //
    // AFTER the jobs are published, so the notice cannot arrive before the
    // commands it is about. Not awaited for its result and never fatal - see
    // postSystemNotice.
    const skipped = overflowCommands(content);
    if (skipped.length) {
      const names = skipped
        .map((c) => (c.target ? `/${c.name}:${c.target}` : `/${c.name}`))
        .join(" ");
      await postSystemNotice({
        conversationID,
        conversationType,
        participants,
        content:
          `Only ${MAX_COMMANDS_PER_MESSAGE} commands run per message. ` +
          `These did not: ${names}`,
      });
    }

    return queued;
  } catch (err) {
    // A command that could not be queued must not fail the message that
    // carried it - the message is already saved by the time this runs.
    console.log("[command] failed to queue:", err?.message || err);
    return 0;
  }
};

module.exports = { queueCommand };
