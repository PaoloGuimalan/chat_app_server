const test = require("node:test");
const assert = require("node:assert/strict");
const { createPreviewDispatcher, repairPendingReceipts, COOLDOWN_MS } = require("./communityAdminPreviews");

const clone = (value) => structuredClone(value);
function matches(row, query) {
  return Object.entries(query).every(([key, value]) => {
    if (key === "$or") return value.some((part) => matches(row, part));
    if (key === "$and") return value.every((part) => matches(row, part));
    if (value && typeof value === "object" && !(value instanceof Date)) {
      return Object.entries(value).every(([op, operand]) => {
        if (op === "$lte") return row[key] != null && row[key] <= operand;
        if (op === "$lt") return row[key] != null && row[key] < operand;
        if (op === "$ne") return row[key] !== operand;
        if (op === "$exists") return (row[key] !== undefined) === operand;
        if (op === "$in") return operand.includes(row[key]);
        throw new Error("Unexpected matcher " + op);
      });
    }
    return value === null ? row[key] == null : row[key] === value;
  });
}
class Collection {
  constructor(rows = []) { this.rows = clone(rows); }
  find(query) {
    let maximum = Infinity;
    const cursor = {
      limit: (value) => { maximum = value; return cursor; },
      toArray: async () => clone(this.rows.filter((row) => matches(row, query)).slice(0, maximum)),
    };
    return cursor;
  }
  async insertMany(rows) { this.rows.push(...clone(rows)); }
  async deleteMany(query) { this.rows = this.rows.filter((row) => !matches(row, query)); }
  async findOne(query) { return clone(this.rows.find((row) => matches(row, query)) || null); }
  async countDocuments(query) { return this.rows.filter((row) => matches(row, query)).length; }
  async findOneAndUpdate(query, update) {
    const row = this.rows.find((item) => matches(item, query));
    if (!row) return { value: null };
    this.apply(row, update);
    return { value: clone(row) };
  }
  apply(row, update) {
    if (Array.isArray(update)) {
      const evaluate = (value) => {
        if (typeof value === "string" && value.startsWith("$")) return row[value.slice(1)];
        if (!value || typeof value !== "object" || value instanceof Date) return value;
        if ("$literal" in value) return value.$literal;
        const [op, values] = Object.entries(value)[0];
        const args = values.map(evaluate);
        if (op === "$ifNull") return args[0] ?? args[1];
        if (op === "$add") return args.reduce((a, b) => a + b, 0);
        if (op === "$eq") return args[0] === args[1];
        if (op === "$cond") return args[0] ? args[1] : args[2];
        throw new Error("Unexpected expression " + op);
      };
      for (const stage of update) Object.assign(row, Object.fromEntries(Object.entries(stage.$set).map(([key, value]) => [key, evaluate(value)])));
      return;
    }
    Object.assign(row, clone(update.$set || {}));
    for (const [key, value] of Object.entries(update.$inc || {})) row[key] = (row[key] || 0) + value;
  }
  async updateOne(query, update, options = {}) {
    let row = this.rows.find((item) => matches(item, query));
    if (!row && options.upsert) { row = { ...query }; this.rows.push(row); }
    if (!row) return { matchedCount: 0 };
    this.apply(row, update);
    return { matchedCount: 1 };
  }
  async updateMany(query, update) {
    for (const row of this.rows.filter((item) => matches(item, query))) this.apply(row, update);
  }
  async replaceOne(query, replacement) {
    const index = this.rows.findIndex((row) => matches(row, query));
    if (index >= 0) this.rows[index] = { ...clone(replacement), _id: this.rows[index]._id };
    else {
      if (this.rows.some((row) => row.preview_key === replacement.preview_key)) {
        throw Object.assign(new Error("Duplicate preview slot"), { code: 11000 });
      }
      this.rows.push({ ...clone(replacement), _id: "physical-slot" });
    }
  }
}
function fixture() {
  let now = new Date("2026-10-27T00:05:00Z");
  let allowed = true;
  const deliveries = new Collection([{
    _id: "delivery", realm_id: "club", community_entity_id: "garden", admin_entity_id: "admin",
    revision: 2, generation: 1, batch_id: "batch-1", due_at: now, lease_until: null,
  }]);
  const receipts = new Collection([1, 2].map((n) => ({
    _id: "receipt-" + n, notification_id: "notice-" + n, admin_entity_id: "admin",
    community_entity_id: "garden", is_read: false, preview_id: null,
  })));
  const notifications = new Collection();
  const snapshots = new Collection();
  const events = [];
  const dispatcher = createPreviewDispatcher({ deliveries, receipts, notifications, snapshots,
    now: () => now, authorize: async () => allowed,
    publish: async (...event) => events.push(event),
  });
  return { deliveries, receipts, notifications, snapshots, events, dispatcher,
    advance: (ms) => { now = new Date(now.getTime() + ms); },
    revoke: () => { allowed = false; },
  };
}

test("dispatch waits until the five-minute boundary and saves a fixed count once", async () => {
  const f = fixture(); f.advance(-1);
  assert.equal(await f.dispatcher.flushOne(), false);
  assert.equal(f.notifications.rows.length, 0);
  f.advance(1);
  assert.equal(await f.dispatcher.flushOne(), true);
  const saved = clone(f.notifications.rows[0]);
  assert.equal(saved.activity_count, 2);
  assert.equal(saved.content.details, "2 new activities in your community. Check them out.");
  assert.equal(saved.isRead, false);
  assert.equal(f.events.length, 2);
  f.receipts.rows[0].is_read = true;
  assert.equal(await f.dispatcher.flushOne(), false);
  assert.deepEqual(f.notifications.rows[0], saved);
});

test("a later batch replaces the community/admin slot with a fresh immutable identity", async () => {
  const f = fixture(); await f.dispatcher.flushOne();
  const first = clone(f.notifications.rows[0]);
  f.receipts.rows.forEach((row) => { row.is_read = true; });
  f.receipts.rows.push({ _id: "new", admin_entity_id: "admin", community_entity_id: "garden", is_read: false, preview_id: null });
  f.advance(COOLDOWN_MS);
  Object.assign(f.deliveries.rows[0], { revision: 3, generation: 2, batch_id: "batch-2", due_at: new Date("2026-10-27T00:10:00Z") });
  await f.dispatcher.flushOne();
  assert.equal(f.notifications.rows.length, 1);
  const second = f.notifications.rows[0];
  assert.notEqual(first.notificationID, second.notificationID);
  assert.equal(second.activity_count, 1);
  assert.equal(second.content.details, "1 new activity in your community. Check them out.");
  assert.equal(second.activity_delivery_version, 2);
});

test("zero unread activities and revoked management permission never save a preview", async () => {
  for (const mode of ["read", "revoked"]) {
    const f = fixture();
    if (mode === "read") f.receipts.rows.forEach((row) => { row.is_read = true; });
    else f.revoke();
    await f.dispatcher.flushOne();
    assert.equal(f.notifications.rows.length, 0);
    assert.equal(f.events.length, 0);
    assert.equal(f.deliveries.rows[0].due_at, null);
  }
});

test("administrators count only their own unread receipts", async () => {
  const f = fixture();
  f.receipts.rows.push({ _id: "other", admin_entity_id: "other-admin", community_entity_id: "garden", is_read: false });
  f.receipts.rows[0].is_read = true;
  await f.dispatcher.flushOne();
  assert.equal(f.notifications.rows[0].activity_count, 1);
});

test("concurrent workers claim a batch once", async () => {
  const f = fixture();
  await Promise.all([f.dispatcher.flushOne(), f.dispatcher.flushOne()]);
  assert.equal(f.notifications.rows.length, 1);
  assert.equal(f.events.length, 2);
});

test("a publication failure retries the same saved snapshot after restart", async () => {
  const f = fixture();
  const realPublish = f.dispatcher;
  const failing = createPreviewDispatcher({ ...f, now: () => new Date("2026-10-27T00:05:00Z"), authorize: async () => true,
    publish: async () => { throw new Error("Redis unavailable"); },
  });
  await assert.rejects(failing.flushOne(), /Redis unavailable/);
  const saved = clone(f.notifications.rows[0]);
  f.receipts.rows[0].is_read = true;
  f.advance(15001);
  await realPublish.flushOne();
  assert.deepEqual(f.notifications.rows[0], saved);
  assert.equal(f.events.length, 2);
});

test("reading all covered activity during save hides the notice before publication", async () => {
  const f = fixture();
  const replace = f.notifications.replaceOne.bind(f.notifications);
  f.notifications.replaceOne = async (...args) => {
    f.receipts.rows.forEach((row) => { row.is_read = true; });
    return replace(...args);
  };
  await f.dispatcher.flushOne();
  assert.equal(f.notifications.rows[0].isRead, true);
  assert.equal(f.notifications.rows[0].activity_count, 2);
  assert.equal(f.events[0][1], "notifications_reload");
});

test("arrivals during delivery get a new window without altering the saved batch", async () => {
  const f = fixture();
  const replace = f.notifications.replaceOne.bind(f.notifications);
  f.notifications.replaceOne = async (...args) => {
    f.receipts.rows.push({ _id: "later", admin_entity_id: "admin", community_entity_id: "garden", is_read: false, preview_id: null });
    f.deliveries.rows[0].revision++;
    return replace(...args);
  };
  await f.dispatcher.flushOne();
  assert.equal(f.notifications.rows[0].activity_count, 2);
  assert.equal(f.deliveries.rows[0].generation, 2);
  assert.equal(f.deliveries.rows[0].due_at.toISOString(), "2026-10-27T00:10:00.000Z");
});

test("an expired older worker cannot replace a newer saved batch", async () => {
  const f = fixture();
  f.notifications.rows.push({ preview_key: "delivery", notificationID: "newer", activity_delivery_version: 3, activity_count: 7 });
  await f.dispatcher.flushOne();
  assert.equal(f.notifications.rows.length, 1);
  assert.equal(f.notifications.rows[0].notificationID, "newer");
  assert.equal(f.events.length, 0);
});

test("a stale worker cannot steal receipt coverage from a newer preview", async () => {
  const f = fixture();
  f.receipts.rows.forEach((row) => { row.preview_id = "newer-batch"; row.preview_version = 3; });
  f.notifications.rows.push({ preview_key: "delivery", notificationID: "newer", activity_delivery_version: 3, activity_count: 2 });
  await f.dispatcher.flushOne();
  assert.ok(f.receipts.rows.every((row) => row.preview_id === "newer-batch"));
});

test("an interrupted receipt enqueue is recovered without extending an existing window", async () => {
  const f = fixture();
  const receipt = f.receipts.rows[0];
  Object.assign(receipt, { scheduled: false, delivery_id: "delivery", realm_id: "club" });
  const due = f.deliveries.rows[0].due_at;
  await repairPendingReceipts({ ...f, now: () => new Date("2026-10-27T00:04:00Z") });
  assert.equal(receipt.scheduled, true);
  assert.deepEqual(f.deliveries.rows[0].due_at, due);
  assert.equal(f.deliveries.rows[0].revision, 3);
  await repairPendingReceipts(f);
  assert.equal(f.deliveries.rows[0].revision, 3);
});

test("an interrupted first enqueue creates a durable delivery window", async () => {
  const f = fixture();
  f.deliveries.rows = [];
  Object.assign(f.receipts.rows[0], { scheduled: false, delivery_id: "delivery", realm_id: "club" });
  await repairPendingReceipts({ ...f, now: () => new Date("2026-10-27T00:00:00Z") });
  assert.equal(f.deliveries.rows.length, 1);
  assert.equal(f.deliveries.rows[0].due_at.toISOString(), "2026-10-27T00:05:00.000Z");
  assert.equal(f.deliveries.rows[0].generation, 1);
});

test("temporary permission failures remain retryable rather than clearing the window", async () => {
  const f = fixture();
  const dispatcher = createPreviewDispatcher({ ...f, now: () => new Date("2026-10-27T00:05:00Z"), authorize: async () => { throw new Error("Permission database offline"); }, publish: async () => {} });
  await assert.rejects(dispatcher.flushOne(), /Permission database offline/);
  assert.notEqual(f.deliveries.rows[0].due_at, null);
  f.advance(15001);
  await f.dispatcher.flushOne();
  assert.equal(f.notifications.rows[0].activity_count, 2);
});

test("an expired worker cannot absorb activity arriving after its immutable snapshot was saved", async () => {
  const f = fixture();
  let resume;
  let paused;
  const blocked = new Promise((resolve) => { paused = resolve; });
  const wait = new Promise((resolve) => { resume = resolve; });
  const update = f.receipts.updateMany.bind(f.receipts);
  let first = true;
  f.receipts.updateMany = async (...args) => {
    if (first) { first = false; paused(); await wait; }
    return update(...args);
  };
  const expiredWorker = f.dispatcher.flushOne();
  await blocked;
  f.advance(61000);
  await f.dispatcher.flushOne();
  f.receipts.rows.push({ _id: "later", admin_entity_id: "admin", community_entity_id: "garden", is_read: false, preview_id: null });
  Object.assign(f.deliveries.rows[0], { revision: 3, generation: 2, batch_id: "batch-2", due_at: new Date("2026-10-27T00:11:01Z") });
  resume();
  await expiredWorker;
  f.advance(COOLDOWN_MS);
  await f.dispatcher.flushOne();
  assert.equal(f.notifications.rows.length, 1);
  assert.equal(f.notifications.rows[0].activity_count, 3);
  assert.equal(f.notifications.rows[0].activity_delivery_id, "batch-2");
});

test("restart after freezing coverage cannot grow the saved batch with later receipts", async () => {
  const f = fixture();
  const replace = f.notifications.replaceOne.bind(f.notifications);
  f.notifications.replaceOne = async () => { throw new Error("Mongo write interrupted"); };
  await assert.rejects(f.dispatcher.flushOne(), /Mongo write interrupted/);
  f.receipts.rows.push({ _id: "late", admin_entity_id: "admin", community_entity_id: "garden", is_read: false, preview_id: null });
  f.deliveries.rows[0].revision++;
  f.notifications.replaceOne = replace;
  f.advance(15001);
  await f.dispatcher.flushOne();
  assert.equal(f.notifications.rows[0].activity_count, 2);
  assert.equal(f.deliveries.rows[0].generation, 2);
  f.advance(COOLDOWN_MS);
  await f.dispatcher.flushOne();
  assert.equal(f.notifications.rows[0].activity_count, 3);
});

test("large unread snapshots are chunked without truncating the saved count", async () => {
  const f = fixture();
  f.receipts.rows = Array.from({ length: 1002 }, (_, index) => ({ _id: "receipt-" + index,
    admin_entity_id: "admin", community_entity_id: "garden", is_read: false, preview_id: null }));
  await f.dispatcher.flushOne();
  assert.equal(f.snapshots.rows.length, 2);
  assert.equal(f.notifications.rows[0].activity_count, 1002);
});

test("an expired unpublished recovery journal is rebuilt under the current lease", async () => {
  const f = fixture();
  Object.assign(f.deliveries.rows[0], { snapshot_id: "expired", snapshot_size: 2 });
  await f.dispatcher.flushOne();
  assert.equal(f.notifications.rows[0].activity_count, 2);
});

test("one failed delivery backs off while other communities can still be dispatched", async () => {
  const f = fixture();
  f.deliveries.rows.push({ ...clone(f.deliveries.rows[0]), _id: "other-delivery", community_entity_id: "other" });
  f.receipts.rows.push({ _id: "other-receipt", admin_entity_id: "admin", community_entity_id: "other", is_read: false });
  const dispatcher = createPreviewDispatcher({ ...f, now: () => new Date("2026-10-27T00:05:00Z"),
    authorize: async (_, community) => { if (community === "garden") throw new Error("Temporary lookup failure"); return true; },
    publish: async () => {},
  });
  await assert.rejects(dispatcher.flushOne(), /Temporary lookup failure/);
  await dispatcher.flushOne();
  assert.equal(f.notifications.rows[0].community_entity_id, "other");
});

test("replacement removes only legacy personal community previews and join notices", async () => {
  const f = fixture();
  f.notifications.rows.push(
    { notificationID: "legacy-summary", toUserID: "admin", community_entity_id: "garden", type: "community_admin_activity" },
    { notificationID: "legacy-join", toUserID: "admin", community_entity_id: "garden", type: "community_join_request" },
    { notificationID: "inbox-join", toUserID: "garden", community_entity_id: "garden", type: "community_join_request" },
    { notificationID: "other-admin", toUserID: "other", community_entity_id: "garden", type: "community_admin_activity" },
    { notificationID: "ordinary", toUserID: "admin", type: "follow" },
  );
  await f.dispatcher.flushOne();
  const ids = f.notifications.rows.map((row) => row.notificationID);
  assert.equal(ids.includes("legacy-summary"), false);
  assert.equal(ids.includes("legacy-join"), false);
  for (const id of ["inbox-join", "other-admin", "ordinary"]) assert.equal(ids.includes(id), true);
  assert.equal(f.notifications.rows.filter((row) => row.preview_key === "delivery").length, 1);
});
