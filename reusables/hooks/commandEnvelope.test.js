/**
 * The envelope and the request built from it.
 *
 * Pure, so all of it is testable without a database or a network. Run with:
 * node --test reusables/hooks/*.test.js
 */

const test = require("node:test");
const assert = require("node:assert");

const {
  buildEnvelope,
  buildWebhookRequest,
  applyParams,
} = require("./commandEnvelope");

const base = {
  command: { name: "summarize", args: "the last hour", target: "neon" },
  messageID: "msg-1",
  conversationID: "conv-1",
  conversationType: "group",
  sender: "entity-paulo",
  senderHandle: "paologuimalan",
  replyingTo: "msg-0",
};

test("the envelope carries who, where and what", () => {
  assert.deepStrictEqual(buildEnvelope(base), {
    command: { name: "summarize", args: "the last hour", target: "neon" },
    invoker: { entity_id: "entity-paulo", handle: "paologuimalan" },
    conversation: { id: "conv-1", type: "group" },
    message: { id: "msg-1", replying_to: "msg-0" },
  });
});

test("a command that is not a reply has no target message", () => {
  const envelope = buildEnvelope({ ...base, replyingTo: undefined });
  assert.strictEqual(envelope.message.replying_to, null);
});

test("absent optionals become empty rather than undefined", () => {
  const envelope = buildEnvelope({
    command: { name: "help" },
    messageID: "m",
    conversationID: "c",
    sender: "e",
  });

  assert.strictEqual(envelope.command.args, "");
  assert.strictEqual(envelope.command.target, null);
  assert.strictEqual(envelope.invoker.handle, "");
  assert.strictEqual(envelope.conversation.type, "");
});

// --- URL parameters --------------------------------------------------------

test("placeholders are filled from the stored definition", () => {
  assert.strictEqual(
    applyParams("https://x.test/{team}/hook", { team: "ops" }),
    "https://x.test/ops/hook",
  );
});

test("a value is encoded, so it cannot change the path", () => {
  assert.strictEqual(
    applyParams("https://x.test/{team}", { team: "../admin" }),
    "https://x.test/..%2Fadmin",
  );
});

test("an unknown placeholder is left visible rather than blanked", () => {
  // A blanked one yields a URL that silently points elsewhere; a visible one
  // is recognisably mis-wired.
  assert.strictEqual(
    applyParams("https://x.test/{nope}", {}),
    "https://x.test/{nope}",
  );
});

// --- the request -----------------------------------------------------------

const row = {
  webhook_url: "https://x.test/{team}/hook",
  webhook_request: {
    params: { team: "ops" },
    query: { mode: "brief" },
    headers: { Authorization: "Bearer secret" },
    payload: { source: "chat" },
  },
};

test("url, query, headers and payload all reach the request", () => {
  const envelope = buildEnvelope(base);
  const request = buildWebhookRequest(row, envelope);

  assert.strictEqual(request.url, "https://x.test/ops/hook?mode=brief");
  assert.strictEqual(request.method, "POST");
  assert.strictEqual(request.headers.Authorization, "Bearer secret");
  assert.strictEqual(request.headers["Content-Type"], "application/json");
  assert.strictEqual(request.body.source, "chat");
  assert.deepStrictEqual(request.body.invoker, envelope.invoker);
});

test("the payload cannot overwrite the envelope", () => {
  // Otherwise a stored definition could make a request claim it came from
  // somebody else, which is what deriving the envelope server-side prevents.
  const envelope = buildEnvelope(base);
  const request = buildWebhookRequest(
    {
      ...row,
      webhook_request: {
        ...row.webhook_request,
        payload: { invoker: { entity_id: "somebody-else" } },
      },
    },
    envelope,
  );

  assert.deepStrictEqual(request.body.invoker, envelope.invoker);
  assert.strictEqual(request.body.invoker.entity_id, "entity-paulo");
});

test("a bare definition still produces a valid request", () => {
  const request = buildWebhookRequest(
    { webhook_url: "https://x.test/hook", webhook_request: {} },
    buildEnvelope(base),
  );

  assert.strictEqual(request.url, "https://x.test/hook");
  assert.deepStrictEqual(Object.keys(request.headers), ["Content-Type"]);
});

test("a missing webhook_request is not an error", () => {
  const request = buildWebhookRequest(
    { webhook_url: "https://x.test/hook" },
    buildEnvelope(base),
  );
  assert.strictEqual(request.url, "https://x.test/hook");
});

test("an existing query string on the url is kept", () => {
  const request = buildWebhookRequest(
    {
      webhook_url: "https://x.test/hook?fixed=1",
      webhook_request: { query: { mode: "brief" } },
    },
    buildEnvelope(base),
  );

  assert.match(request.url, /fixed=1/);
  assert.match(request.url, /mode=brief/);
});
