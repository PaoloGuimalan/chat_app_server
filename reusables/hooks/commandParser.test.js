/**
 * The parser, held to the shared corpus.
 *
 * Every case comes from commandGrammar.json rather than being written here, so
 * that this suite and whatever Go and Django eventually run are provably the
 * same suite. A case added there is a case every implementation must then
 * pass; a case added here would only ever prove something about Node.
 *
 * Run with:  node --test reusables/hooks/*.test.js
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { parseCommand, parseCommands,
  MAX_COMMANDS_PER_MESSAGE,
  overflowCommands,
} = require("./commandParser");

const CORPUS = path.join(__dirname, "commandGrammar.json");

test("the shared grammar corpus is present", () => {
  assert.ok(
    fs.existsSync(CORPUS),
    "commandGrammar.json is the spec - without it this suite proves nothing",
  );
});

const grammar = JSON.parse(fs.readFileSync(CORPUS, "utf8"));

test("every case the corpus says is a command, parses", async (t) => {
  for (const item of grammar.matches) {
    await t.test(`${JSON.stringify(item.input)} - ${item.why}`, () => {
      const parsed = parseCommand(item.input);
      assert.ok(parsed, "expected a command, got null");
      assert.strictEqual(parsed.name, item.name, "name");
      assert.strictEqual(parsed.target, item.target, "target");
      assert.strictEqual(parsed.args, item.args, "args");
    });
  }
});

test("every case the corpus says is not a command, does not", async (t) => {
  for (const item of grammar.nonMatches) {
    await t.test(`${JSON.stringify(item.input)} - ${item.why}`, () => {
      assert.strictEqual(
        parseCommand(item.input),
        null,
        "expected null, got a command",
      );
    });
  }
});

// Not in the corpus because they are about this function's contract rather
// than about the grammar - another implementation in another language would
// express them differently or not need them at all.

test("a non-string is not a command", () => {
  for (const value of [null, undefined, 42, {}, []]) {
    assert.strictEqual(parseCommand(value), null, String(value));
  }
});

test("called with nothing at all", () => {
  assert.strictEqual(parseCommand(), null);
});

test("the corpus covers both outcomes", () => {
  assert.ok(grammar.matches.length >= 10, "too few positive cases to trust");
  assert.ok(grammar.nonMatches.length >= 10, "too few negative cases to trust");
});

test("every multi-command case the corpus states, parses", async (t) => {
  for (const c of grammar.multiple ?? []) {
    await t.test(`${JSON.stringify(c.input)} - ${c.why}`, () => {
      assert.deepStrictEqual(parseCommands(c.input), c.commands);
    });
  }
});

test("parseCommand is the first of parseCommands", () => {
  // Defined in terms of each other in the parser, and pinned here so a future
  // edit cannot let the single and multi views disagree about what a command
  // is.
  for (const input of [
    "/wake:neon /wake:xenon",
    "/stop and then /summarize the thread",
    "hey @ana /members please",
    "nothing here",
  ]) {
    assert.deepStrictEqual(parseCommand(input), parseCommands(input)[0] ?? null);
  }
});

test("a message cannot run more commands than the cap", () => {
  // Each command past the cap is a queued job per resolved bot - an LLM call
  // or somebody else's webhook - so the bound is tighter than the mention
  // one. See MAX_COMMANDS_PER_MESSAGE.
  const many = Array.from({ length: 60 }, (_, i) => `/wake:bot${i}`).join(" ");

  assert.strictEqual(parseCommands(many).length, MAX_COMMANDS_PER_MESSAGE);
});

test("what the cap dropped is reportable, in the order it was typed", () => {
  // Returned so the System bot can SAY which ones did not run. Quietly
  // running five of eight is indistinguishable from three failing.
  const text = "/one /two /three /four /five /six /seven:neon";

  assert.deepStrictEqual(overflowCommands(text), [
    { name: "six", target: null },
    { name: "seven", target: "neon" },
  ]);
});

test("a message inside the cap has nothing to report", () => {
  assert.deepStrictEqual(overflowCommands("/wake:neon /wake:xenon"), []);
  assert.deepStrictEqual(overflowCommands("no commands here"), []);
  assert.deepStrictEqual(overflowCommands(""), []);
});

test("the run list and the overflow together are everything typed", () => {
  // Neither drops a command on the floor: every command in the message is in
  // exactly one of the two lists.
  const text = Array.from({ length: 9 }, (_, i) => `/cmd${i}`).join(" ");

  const ran = parseCommands(text).map((c) => c.name);
  const skipped = overflowCommands(text).map((c) => c.name);

  assert.deepStrictEqual(
    [...ran, ...skipped],
    Array.from({ length: 9 }, (_, i) => `cmd${i}`),
  );
});

test("the cap drops the extra commands, not the message", () => {
  const over = Array.from(
    { length: MAX_COMMANDS_PER_MESSAGE + 5 },
    (_, i) => `/wake:bot${i}`,
  ).join(" ");
  const parsed = parseCommands(over);

  // The ones that survive are the ones typed FIRST, in order.
  assert.strictEqual(parsed[0].target, "bot0");
  assert.strictEqual(
    parsed[parsed.length - 1].target,
    `bot${MAX_COMMANDS_PER_MESSAGE - 1}`,
  );
});

test("the last command kept still takes the rest of the message", () => {
  // Text belonging to commands the cap dropped is nothing but text: they are
  // not running, so it is not their argument.
  const parsed = parseCommands("/alpha /beta tail words");

  assert.strictEqual(parsed[parsed.length - 1].args, "tail words");
});
