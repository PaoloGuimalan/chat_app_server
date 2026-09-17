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

const { parseCommand } = require("./commandParser");

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
