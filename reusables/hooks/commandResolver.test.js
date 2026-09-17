/**
 * What can be tested without a database: the guard paths, the public shape,
 * and the two clauses that decide reach.
 *
 * The query itself needs the table, so it is verified when the migration is
 * applied rather than here. Run with:  node --test reusables/hooks/*.test.js
 */

const test = require("node:test");
const assert = require("node:assert");

const {
  resolveCommand,
  publicCommand,
  RESOLVE_SQL,
} = require("./commandResolver");

// --- guards: these return before the pool is ever touched -------------------

test("nothing to resolve is an empty list, not an error", async () => {
  assert.deepStrictEqual(await resolveCommand(null), []);
  assert.deepStrictEqual(await resolveCommand(undefined, []), []);
  assert.deepStrictEqual(await resolveCommand({ name: "" }, []), []);
  assert.deepStrictEqual(await resolveCommand({}, []), []);
});

// --- the public shape ------------------------------------------------------

const row = {
  id: "cmd-1",
  name: "summarize",
  description: "Summarise the last hour.",
  category: "webhook",
  responds: "bot",
  webhook_url: "https://example.test/hook",
  webhook_request: {
    headers: { Authorization: "Bearer clt_secret_value" },
  },
  bot_id: "bot-1",
  bot_entity_id: "entity-neon",
  bot_handle: "neon",
  bot_is_system: false,
};

test("the public shape carries what autocomplete needs", () => {
  assert.deepStrictEqual(publicCommand(row), {
    name: "summarize",
    description: "Summarise the last hour.",
    responds: "bot",
    bot: "neon",
  });
});

test("the public shape leaks no part of the request", () => {
  const serialised = JSON.stringify(publicCommand(row));

  for (const secret of [
    "webhook_url",
    "webhook_request",
    "example.test",
    "Authorization",
    "clt_secret_value",
    "category",
  ]) {
    assert.ok(
      !serialised.includes(secret),
      `${secret} must not reach a client`,
    );
  }
});

test("a field added to a row does not appear in the public shape", () => {
  // The allow-list is the point: ToolSerializer in Neon was fields="__all__",
  // which is how a tool credential ended up serialised into a model prompt.
  const withNewColumn = { ...row, some_future_secret: "should-not-appear" };

  assert.ok(
    !JSON.stringify(publicCommand(withNewColumn)).includes("should-not-appear"),
  );
});

// --- the clauses that decide reach -----------------------------------------
//
// Asserting on SQL text is usually a smell. These two are the authorization
// boundary - without them a command resolves in conversations its bot is not
// in - so a tripwire against silent deletion is worth the brittleness, the
// same way the @mention drift test asserts on pattern text.

test("reach is restricted to the bot's own conversations", () => {
  assert.match(
    RESOLVE_SQL,
    /b\.is_system OR b\.entity_id = ANY/,
    "the participant check is what stops a command resolving everywhere",
  );
});

test("only active commands on active bots resolve", () => {
  assert.match(RESOLVE_SQL, /c\.is_active/);
  assert.match(RESOLVE_SQL, /b\.is_active/);
});

test("the target narrows by handle and is optional", () => {
  assert.match(RESOLVE_SQL, /\$3::text IS NULL OR lower\(b\.handle\) = \$3/);
});
