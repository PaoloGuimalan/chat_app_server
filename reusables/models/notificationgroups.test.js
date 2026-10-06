/**
 * Run with:  node --test reusables/models/notificationgroups.test.js
 *
 * The group key is a Mongo expression, and there is no Mongo to run it
 * against here (the server's .env points at production). So these tests run
 * it through a small evaluator for exactly the operators it uses - with
 * Mongo's semantics for a MISSING field, which is what decides whether a
 * legacy row without a target can group (it must not).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  GROUP_SPECS,
  assertActionsSafe,
  groupKeyExpression,
  specFor,
  groupSentence,
  groupIdOf,
} = require("./notificationgroups");

const MISSING = Symbol("missing");

const fieldOf = (doc, path) =>
  path.split(".").reduce((value, part) => {
    if (value === MISSING || value === null || typeof value !== "object") {
      return MISSING;
    }
    return Object.prototype.hasOwnProperty.call(value, part)
      ? value[part]
      : MISSING;
  }, doc);

// BSON order for what the key compares: missing and null sit below every
// string/number, and $gt against null is true only for a real value.
const isNullish = (value) => value === MISSING || value === null;

const evaluate = (expr, doc) => {
  if (typeof expr === "string" && expr.startsWith("$")) {
    return fieldOf(doc, expr.slice(1));
  }
  if (expr === null || typeof expr !== "object") return expr;
  if (Array.isArray(expr)) return expr.map((e) => evaluate(e, doc));

  const [op] = Object.keys(expr);
  const args = expr[op];
  switch (op) {
    case "$switch": {
      for (const branch of args.branches) {
        if (evaluate(branch.case, doc) === true) return evaluate(branch.then, doc);
      }
      return evaluate(args.default, doc);
    }
    case "$and":
      return args.every((a) => evaluate(a, doc) === true);
    case "$eq": {
      const [a, b] = args.map((a) => evaluate(a, doc));
      if (a === MISSING || b === MISSING) return a === b;
      return JSON.stringify(a) === JSON.stringify(b);
    }
    case "$gt": {
      const [a, b] = args.map((a) => evaluate(a, doc));
      if (typeof a === "number" && typeof b === "number") return a > b;
      if (b !== null) throw new Error("only $gt against null or numbers");
      return !isNullish(a);
    }
    case "$ifNull": {
      const [a, b] = args;
      const value = evaluate(a, doc);
      return isNullish(value) ? evaluate(b, doc) : value;
    }
    case "$cond": {
      const [condition, then, otherwise] = args;
      return evaluate(condition, doc) === true
        ? evaluate(then, doc)
        : evaluate(otherwise, doc);
    }
    case "$isArray":
      return Array.isArray(evaluate(args, doc));
    case "$size": {
      const value = evaluate(args, doc);
      // Mongo errors on a non-array here, which is why it is guarded.
      if (!Array.isArray(value)) throw new Error("$size of a non-array");
      return value.length;
    }
    default: {
      // A plain document: evaluate each field, dropping MISSING the way
      // Mongo leaves an absent field out of a built document.
      const out = {};
      for (const [key, value] of Object.entries(expr)) {
        if (key.startsWith("$")) throw new Error(`unhandled operator ${key}`);
        const v = evaluate(value, doc);
        if (v !== MISSING) out[key] = v;
      }
      return out;
    }
  }
};

const keyOf = (doc) => JSON.stringify(evaluate(groupKeyExpression(), doc));

let seq = 0;
const notification = (fields) => ({
  _id: `oid${++seq}`,
  toUserID: "me",
  fromUserID: "maya",
  referenceID: `ref${seq}`,
  content: { headline: "Post Reaction", details: "@maya reacted" },
  isRead: false,
  ...fields,
});

const reaction = (postId, extra = {}) =>
  notification({
    type: "post_reaction",
    target: { type: "post", supportingID: postId, anchor: null },
    ...extra,
  });

test("reactions on the same post share a key", () => {
  assert.equal(keyOf(reaction("p1")), keyOf(reaction("p1", { fromUserID: "leo" })));
});

test("reactions on different posts do not", () => {
  assert.notEqual(keyOf(reaction("p1")), keyOf(reaction("p2")));
});

test("different types on the same post do not", () => {
  const comment = notification({
    type: "post_comment",
    content: { headline: "Post Comment", details: "commented" },
    target: { type: "post", supportingID: "p1", anchor: "c9" },
  });
  assert.notEqual(keyOf(reaction("p1")), keyOf(comment));
});

test("a row with no target never groups", () => {
  const legacyA = notification({ type: "post_reaction" });
  const legacyB = notification({ type: "post_reaction" });
  assert.notEqual(keyOf(legacyA), keyOf(legacyB));
  assert.ok(keyOf(legacyA).includes("single"));
});

test("a null target id never groups", () => {
  const a = reaction(null);
  const b = reaction(null);
  assert.notEqual(keyOf(a), keyOf(b));
});

test("comments group per post, and so do replies - apart from comments", () => {
  const comment = (anchor) =>
    notification({
      type: "post_comment",
      content: { headline: "Post Comment", details: "commented" },
      target: { type: "post", supportingID: "p1", anchor },
    });
  // Each comment has its own anchor, but "commented on your post" groups by
  // the post.
  assert.equal(keyOf(comment("c1")), keyOf(comment("c2")));

  const reply = (postId, anchor) =>
    notification({
      type: "post_comment",
      content: { headline: "Replied Comment", details: "replied" },
      target: { type: "post", supportingID: postId, anchor },
    });
  // Replies to different comments of yours, on the same post: one row.
  assert.equal(keyOf(reply("p1", "c3")), keyOf(reply("p1", "c4")));
  assert.notEqual(keyOf(reply("p1", "c3")), keyOf(reply("p2", "c3")));
  assert.notEqual(keyOf(reply("p1", "c3")), keyOf(comment("c1")));
  // A legacy reply with no target cannot say which post - it stays alone.
  const legacy = () =>
    notification({
      type: "post_comment",
      content: { headline: "Replied Comment", details: "replied" },
    });
  assert.notEqual(keyOf(legacy()), keyOf(legacy()));
});

test("comment reactions group per COMMENT, not per post", () => {
  const commentReaction = (anchor) =>
    notification({
      type: "comment_reaction",
      content: { headline: "Comment Reaction", details: "reacted" },
      target: { type: "post", supportingID: "p1", anchor },
    });
  assert.equal(keyOf(commentReaction("c1")), keyOf(commentReaction("c1")));
  assert.notEqual(keyOf(commentReaction("c1")), keyOf(commentReaction("c2")));
  // No anchor: which comment is unknown, so it stays alone.
  const noAnchorA = commentReaction(null);
  const noAnchorB = commentReaction(null);
  assert.notEqual(keyOf(noAnchorA), keyOf(noAnchorB));
});

test("follows group per recipient; an approved follow request groups per person", () => {
  const follow = (from, headline = "New Follower") =>
    notification({
      type: "follow",
      fromUserID: from,
      referenceID: from,
      content: { headline, details: "started following you" },
    });
  assert.equal(keyOf(follow("maya")), keyOf(follow("leo")));
  assert.notEqual(
    keyOf(follow("maya", "Follow Request Approved")),
    keyOf(follow("leo", "Follow Request Approved")),
  );
  // A follow is never folded into its sender's people row.
  assert.notEqual(keyOf(follow("maya")), keyOf(follow("maya", "Follow Request Approved")));
});

test("a share groups by its post, from target or from referenceID", () => {
  const withTarget = notification({
    type: "shared_post_notification",
    content: { headline: "Shared post", details: "shared" },
    target: { type: "post", supportingID: "p7" },
  });
  const legacy = notification({
    type: "shared_post_notification",
    content: { headline: "Shared post", details: "shared" },
    referenceID: "p7",
  });
  assert.equal(keyOf(withTarget), keyOf(legacy));
});

// The people family: every connection row between you and one person.
const contactRequest = (from, connection) =>
  notification({
    type: "contact_request",
    fromUserID: from,
    referenceID: connection,
    referenceStatus: false,
    content: { headline: "Contact Request", details: "have sent a contact request" },
  });
const contactAccepted = (from, connection) =>
  notification({
    type: "info_contact_accept",
    fromUserID: from,
    referenceID: connection,
    referenceStatus: true,
    content: { headline: "Accepted Request", details: "accepted your request" },
  });
const followRequest = (from) =>
  notification({
    type: "follow_request",
    fromUserID: from,
    referenceID: from,
    referenceStatus: false,
    content: { headline: "Follow Request", details: "requested to follow you" },
  });
const followApproved = (from) =>
  notification({
    type: "follow",
    fromUserID: from,
    referenceID: from,
    content: { headline: "Follow Request Approved", details: "approved your follow request" },
  });

test("connections from one person are one row, whatever their type", () => {
  const juan = [
    contactRequest("juan", "conv1"),
    // A fresh connection id - a declined pair asking again - is still Juan.
    contactRequest("juan", "conv2"),
    contactAccepted("juan", "conv1"),
    followRequest("juan"),
    followApproved("juan"),
  ];
  const keys = new Set(juan.map(keyOf));
  assert.equal(keys.size, 1);
  assert.ok(!keyOf(juan[0]).includes("single"));
});

test("connections from different people never share a row", () => {
  assert.notEqual(keyOf(contactRequest("juan", "c1")), keyOf(contactRequest("maya", "c2")));
  assert.notEqual(keyOf(contactAccepted("juan", "c1")), keyOf(followApproved("maya")));
});

test("a connection row with no sender stays alone", () => {
  const orphan = () => notification({ type: "contact_request", fromUserID: null });
  assert.notEqual(keyOf(orphan()), keyOf(orphan()));
});

test("each request keeps its own buttons - they are not in the key", () => {
  // Stored buttons on one row do not split the person's group: they are
  // answered on that row, inside it.
  const stored = contactRequest("juan", "conv9");
  stored.actions = [{ platform: "web", id: "accept", name: "Confirm", type: "api-request" }];
  assert.equal(keyOf(stored), keyOf(contactRequest("juan", "conv1")));
});

test("same type and target but different STORED buttons do not group", () => {
  const withButtons = (url) =>
    reaction("p1", {
      actions: [{ platform: "web", id: "go", name: "Open", type: "in-app-redirect", route: url }],
    });
  assert.notEqual(keyOf(withButtons("/a")), keyOf(withButtons("/b")));
  assert.notEqual(keyOf(withButtons("/a")), keyOf(reaction("p1")));
  assert.equal(keyOf(withButtons("/a")), keyOf(withButtons("/a")));
});

test("no stored buttons keys alike however it is spelled", () => {
  const missing = reaction("p1");
  const nulls = reaction("p1", { actions: null, redirects: null });
  const empty = reaction("p1", { actions: [], redirects: [] });
  assert.equal(keyOf(missing), keyOf(nulls));
  assert.equal(keyOf(missing), keyOf(empty));
});

test("an invite never groups - its buttons carry its own token", () => {
  const invite = (token) =>
    notification({
      type: "realm_invite",
      content: { headline: "Invite", details: "invited you" },
      target: { type: "invite", supportingID: token },
      actions: [
        { platform: "web", id: "accept", name: "Accept", type: "api-request", payload: { invite_token: token } },
      ],
    });
  assert.notEqual(keyOf(invite("t1")), keyOf(invite("t2")));
  assert.ok(keyOf(invite("t1")).includes("single"));
});

test("same type and target but different stored destinations do not group", () => {
  const routed = (route) =>
    reaction("p1", { redirects: [{ platform: "web", type: "post", route }] });
  assert.notEqual(keyOf(routed("/post/p1")), keyOf(routed("/post/p1#c2")));
});

test("system notices never group", () => {
  const notice = () =>
    notification({
      type: "system",
      toUserID: "all",
      content: { headline: "Maintenance", details: "Tonight" },
    });
  assert.notEqual(keyOf(notice()), keyOf(notice()));
});

test("a type with derived buttons groups only with memberActions", () => {
  assert.doesNotThrow(() => assertActionsSafe());
  assert.throws(() =>
    assertActionsSafe([{ type: "contact_request", by: "recipient", action: "x" }]),
  );
  assert.doesNotThrow(() =>
    assertActionsSafe([
      { type: "contact_request", by: "sender", memberActions: true, family: "f", phrase: "x" },
    ]),
  );
  // Every spec can be put into words.
  assert.throws(() => assertActionsSafe([{ type: "poke", by: "sender", family: "f" }]));
  assert.throws(() => assertActionsSafe([{ type: "poke", by: "recipient" }]));
});

test("every spec that groups rows with buttons keeps them per row", () => {
  for (const spec of GROUP_SPECS) {
    const key = evaluate(groupKeyExpression([spec]), {
      _id: "x",
      type: spec.type,
      fromUserID: "a",
      toUserID: "b",
      referenceID: "r",
      content: { headline: spec.headline },
      target: { supportingID: "p", anchor: "c" },
      actions: [{ id: "go" }],
      redirects: [{ route: "/x" }],
    });
    assert.ok(!key.single, spec.type);
    if (spec.memberActions) {
      assert.equal(key.actions, null, spec.type);
      assert.equal(key.redirects, null, spec.type);
    } else {
      assert.deepEqual(key.actions, [{ id: "go" }], spec.type);
    }
  }
});

test("specFor labels a group with its action", () => {
  assert.equal(specFor(reaction("p1")).action, "reacted to your post");
  assert.equal(
    specFor(
      notification({
        type: "post_comment",
        content: { headline: "Replied Comment", details: "replied" },
      }),
    ).action,
    "replied to your comments on a post",
  );
  assert.equal(specFor(notification({ type: "poke" })), null);
});

test("a people row says what that person did, each thing once, newest first", () => {
  assert.equal(
    groupSentence([
      followApproved("juan"),
      contactAccepted("juan", "c1"),
      contactRequest("juan", "c1"),
      contactAccepted("juan", "c1"),
      contactRequest("juan", "c2"),
    ]),
    "approved your follow request, accepted your request and sent you a contact request",
  );
  assert.equal(
    groupSentence([contactRequest("juan", "c1"), contactRequest("juan", "c2")]),
    "sent you a contact request",
  );
  assert.equal(
    groupSentence([followRequest("juan"), contactRequest("juan", "c1")]),
    "asked to follow you and sent you a contact request",
  );
  assert.equal(groupSentence([reaction("p1"), reaction("p1")]), "reacted to your post");
});

test("every spec's type is distinct per headline", () => {
  const seen = new Set();
  for (const spec of GROUP_SPECS) {
    const id = `${spec.type}|${spec.headline || ""}`;
    assert.ok(!seen.has(id), `duplicate spec ${id}`);
    seen.add(id);
  }
});

test("a group's id is stable for the same key", () => {
  assert.equal(groupIdOf({ a: 1 }), groupIdOf({ a: 1 }));
  assert.notEqual(groupIdOf({ a: 1 }), groupIdOf({ a: 2 }));
});
