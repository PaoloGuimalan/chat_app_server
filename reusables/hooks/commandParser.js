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
 * "/api/v1/users" have no whitespace before their inner slashes. The first
 * match wins, so there is still exactly one command per message and everything
 * after its name is arguments.
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

/**
 * The command in this message, or null.
 *
 * @param {string} text
 * @returns {{name: string, target: string|null, args: string}|null}
 */
function parseCommand(text = "") {
  if (typeof text !== "string" || text === "") return null;

  const match = text.match(COMMAND_PATTERN);
  if (!match) return null;

  return {
    name: match[1].toLowerCase(),
    // null rather than "" so "no target" cannot be confused with a target that
    // resolved to nothing.
    target: match[2] ? match[2].toLowerCase() : null,
    args: (match[3] || "").trim(),
  };
}

module.exports = { parseCommand, COMMAND_PATTERN };
