/**
 * Parsing `/command` out of a message.
 *
 * PURE, LIKE extractMentionUsernames
 * ----------------------------------
 * This finds a command and returns it. It does not resolve which bot owns the
 * name, does not check permissions and does not execute anything - the caller
 * does all of that, the same division transformers.js already follows for
 * mentions.
 *
 * The reason is not tidiness. Resolution needs the conversation's members, and
 * execution can take seconds (an LLM behind a webhook). A parser that executed
 * would hold the sender's HTTP request open for the length of somebody else's
 * model call.
 *
 * ANYWHERE A WORD STARTS, AND THE FIRST ONE WINS
 * ----------------------------------------------
 * Exactly where a mention can go, and for the same reason: people address a
 * bot the way they address a person, and "@juanlazy /summarize the thread"
 * reads as one thought. Requiring the command to be the first thing in the
 * message made that sentence run nothing at all, silently.
 *
 * The cost is that "use the /summarize command" now parses. That is accepted
 * on the same grounds mentions accept it: RESOLUTION is the net. A parsed name
 * runs only if a bot in this conversation declares it, so talking about a
 * command somebody here owns does fire it, and talking about any other does
 * not - the same way "@ana" only notifies an Ana who is actually a member.
 *
 * `(?:^|\s)` is what keeps a slash inside a word out: "and/or" and
 * "/api/v1/users" have no whitespace before their inner slashes.
 *
 * SEVERAL PER MESSAGE
 * -------------------
 * "/wake:neon /wake:xenon" is one thought - wake both - and running only the
 * first was a message that visibly contained two commands doing half of what
 * it said. `parseCommands` returns every one; `parseCommand` is the first,
 * for callers that want a single.
 *
 * Capped at MAX_COMMANDS_PER_MESSAGE - see below.
 *
 * Each command's ARGUMENTS run to the next command, not to the end of the
 * message. Otherwise the first command in that example would be handed
 * "/wake:xenon" as its argument - the text of the instruction that follows
 * it, which belongs to that instruction and not to this one.
 *
 * `//summarize` is the escape hatch, and it falls out of the charset rather
 * than being a special case: the second slash is not a name character, and the
 * second one is not preceded by whitespace either.
 *
 * THE GRAMMAR IS PINNED BY A CORPUS, NOT BY THIS REGEX
 * ---------------------------------------------------
 * commandGrammar.json holds the agreed inputs and outputs. When Go needs this
 * - the moment bots type commands - it reads that file and runs the same
 * cases, rather than translating this pattern and hoping. The @mention grammar
 * exists three times already and needed a drift test to stay honest; a drifted
 * mention notifies the wrong person, while a drifted command runs something.
 */

// name:   [A-Za-z0-9-]{1,32}   matches BotCommand.name's validator, lowercased
//                              on the way out because mobile keyboards
//                              capitalise and nobody means that.
// target: [A-Za-z0-9._-]{1,50} a handle. bot_bot.handle is 50; the mention
//                              grammar allows dots and underscores, so this
//                              does too.
// The lookahead is what stops "/summarizeX" matching "summarize", and what
// makes "/summarize." not a command rather than a command named "summarize"
// with a full stop quietly dropped.
const COMMAND_PATTERN =
  /(?:^|\s)\/([A-Za-z0-9-]{1,32})(?::([A-Za-z0-9._-]{1,50}))?(?=$|\s)\s*([\s\S]*)$/;

// The same grammar with no argument capture, for scanning a message for EVERY
// command. Global, so it is rebuilt per call rather than shared - a `g` regex
// carries `lastIndex` on the object, and one reused across messages would
// start matching from wherever the previous one stopped.
const commandScanner = () =>
  /(?:^|\s)\/([A-Za-z0-9-]{1,32})(?::([A-Za-z0-9._-]{1,50}))?(?=$|\s)/g;

// How many commands one message may run.
//
// TIGHTER THAN THE MENTION BOUND (MAX_MENTIONS_PER_COMMENT is 20) on purpose,
// because the two cost different things. A mention past the bound is a
// notification nobody wanted; a command past it is a QUEUED JOB for every bot
// that resolves it - an LLM call, or an outbound webhook to somebody else's
// server. One message should not be able to buy sixty of those.
//
// Past the limit the extra commands are DROPPED, not the message: what was
// typed is still said, and the first few still run. Silently refusing the
// whole message would be a worse answer to a mistake - and the System bot
// says which ones did not run, so it is not silent either.
const MAX_COMMANDS_PER_MESSAGE = 5;

/**
 * Every command in this message, in the order they were typed.
 *
 * @param {string} text
 * @returns {Array<{name: string, target: string|null, args: string}>}
 */
function scanCommands(text) {
  if (typeof text !== "string" || text === "") return [];
  return [...text.matchAll(commandScanner())];
}

/**
 * The commands this message typed but will NOT run, because of the cap.
 *
 * Returned so the caller can SAY so. A message that visibly contains eight
 * commands and quietly runs five is indistinguishable from five of them
 * failing, and there is nothing in the conversation to tell the difference.
 *
 * @param {string} text
 * @returns {Array<{name: string, target: string|null}>}
 */
function overflowCommands(text = "") {
  return scanCommands(text)
    .slice(MAX_COMMANDS_PER_MESSAGE)
    .map((match) => ({
      name: match[1].toLowerCase(),
      target: match[2] ? match[2].toLowerCase() : null,
    }));
}

function parseCommands(text = "") {
  const matches = scanCommands(text).slice(0, MAX_COMMANDS_PER_MESSAGE);

  return matches.map((match, index) => {
    // The token ends where the match does; the arguments run from there to
    // the NEXT command, or to the end of the message for the last one.
    const tokenEnd = match.index + match[0].length;
    const next = matches[index + 1];
    // The last KEPT command's arguments run to the end of the message. That
    // is also right when the cap dropped commands after it: they are not
    // running, so their text is nothing but text.
    const argsEnd = next === undefined ? text.length : next.index;

    return {
      name: match[1].toLowerCase(),
      // null rather than "" so "no target" cannot be confused with a target
      // that resolved to nothing.
      target: match[2] ? match[2].toLowerCase() : null,
      args: text.slice(tokenEnd, argsEnd).trim(),
    };
  });
}

/**
 * The FIRST command in this message, or null.
 *
 * Kept for callers that carry a single command - the realtime frame is one -
 * and defined in terms of parseCommands so the two cannot disagree about what
 * a command is.
 *
 * @param {string} text
 * @returns {{name: string, target: string|null, args: string}|null}
 */
function parseCommand(text = "") {
  return parseCommands(text)[0] ?? null;
}

module.exports = {
  parseCommand,
  parseCommands,
  overflowCommands,
  COMMAND_PATTERN,
  MAX_COMMANDS_PER_MESSAGE,
};
