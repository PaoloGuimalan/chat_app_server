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

const { parseCommand } = require("./commandParser");
const { resolveCommand } = require("./commandResolver");
const { buildEnvelope } = require("./commandEnvelope");
const { publish, QUEUES } = require("../rabbitmq/workqueue");

/**
 * @returns {Promise<number>} how many jobs were queued. 0 is the ordinary
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

    // Usually parsed already by the caller, which needs it for the realtime
    // frame too. Parsing again here would be a second chance for the two to
    // disagree about what was typed.
    const parsed = command || parseCommand(content);
    if (!parsed) return 0;

    const resolved = await resolveCommand(parsed, participants);

    // Bot commands are the bot's own business - see the module docstring.
    const rows = resolved.filter(
      (row) => row.category === "system" || row.category === "webhook",
    );
    if (!rows.length) {
      // A typo, a command whose bot is not here, a target naming a bot without
      // it, or one that is a bot's to run. All the same here: nothing to queue.
      return 0;
    }

    const envelope = buildEnvelope({
      command: parsed,
      messageID,
      conversationID,
      conversationType,
      sender,
      senderHandle,
      replyingTo,
    });

    // One job per bot. Fan-out is resolved HERE rather than in the worker, so
    // a slow or failing bot cannot hold up the others.
    let queued = 0;
    for (const row of rows) {
      const ok = await publish(QUEUES.RUN_COMMAND, {
        command_id: row.id,
        envelope,
      });
      if (ok) queued += 1;
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
