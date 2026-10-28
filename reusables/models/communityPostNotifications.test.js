const test = require("node:test");
const assert = require("node:assert/strict");
const { createCommunityPostNotifier, noticeID } = require("./communityPostNotifications");

const field = (row, key) => key.split(".").reduce((value, part) => value?.[part], row);
const matches = (row, query) => Object.entries(query).every(([key, value]) => {
  const actual = field(row, key);
  if (value && typeof value === "object") {
    if ("$exists" in value) return (actual !== undefined) === value.$exists;
    if ("$in" in value) return value.$in.includes(actual);
    if ("$ne" in value) return actual !== value.$ne;
    if ("$lte" in value) return actual <= value.$lte;
  }
  return actual === value;
});
function fixture({ anonymous = false } = {}) {
  const rows = [];
  const events = [];
  let timestamp = "2026-10-28T00:00:00.000Z";
  let post = { post_id: "post", realm_id: "club", community_entity_id: "community", community_name: "Garden Club", author_id: "maya", handle: "maya", is_anonymous: anonymous };
  const notifications = {
    async distinct(key, query) {
      return [...new Set(rows.filter((row) => matches(row, query)).map((row) => field(row, key)))];
    },
    async updateOne(query, updates, options = {}) {
      let row = rows.find((item) => matches(item, query));
      const inserted = !row;
      if (inserted && !options.upsert) return { matchedCount: 0, upsertedCount: 0 };
      if (inserted) {
        if (query._id && rows.some((item) => item._id === query._id)) throw Object.assign(new Error("duplicate"), { code: 11000 });
        row = { _id: query._id || "row-" + rows.length, ...(updates.$setOnInsert || {}) };
        rows.push(row);
      }
      Object.assign(row, updates.$set || {});
      return { matchedCount: inserted ? 0 : 1, upsertedCount: inserted ? 1 : 0 };
    },
    async findOne(query) { return rows.find((row) => matches(row, query)) || null; },
    async countDocuments(query) { return rows.filter((row) => matches(row, query)).length; },
    async deleteMany(query) {
      for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], query)) rows.splice(i, 1);
    },
  };
  let allowed = true;
  const notify = createCommunityPostNotifier({ notifications,
    client: { query: async (sql) => ({ rows: sql.includes("FROM newsfeed_post") ? (post ? [post] : []) : [{ entity_id: "admin" }, { entity_id: "maya" }] }) },
    canManage: async () => allowed,
    publish: async (...event) => events.push(event),
    now: () => timestamp,
  });
  return { rows, events, notifications, notify, setPost: (next) => { post = next; }, setTime: (next) => { timestamp = next; }, revoke: () => { allowed = false; } };
}

test("new community posts immediately write inbox activity and fixed admin preview", async () => {
  const f = fixture();
  await f.notify("post");
  const canonical = f.rows.find((row) => row.type === "community_post_created");
  assert.equal(canonical.toUserID, "community");
  assert.equal(canonical.fromUserID, "maya");
  assert.equal(canonical.target.supportingID, "post");
  assert.equal(f.rows.filter((row) => row.type === "community_admin_inbox").length, 1);
  const preview = f.rows.find((row) => row.type === "community_admin_activity");
  assert.equal(preview.toUserID, "admin");
  assert.equal(preview.fromUserID, "community");
  assert.ok(f.rows.every((row) => !Object.hasOwn(row, "community_entity_id")));
  assert.equal(preview.content.details, "1 new activity in your community. Check them out.");
  assert.equal(preview.target.supportingID, "club");
  assert.ok(f.events.some((event) => event[1] === "community_admin_preview_changed"));
});

test("anonymous post notices never persist the author's identity", async () => {
  const f = fixture({ anonymous: true });
  await f.notify("post");
  assert.equal(JSON.stringify(f.rows).includes("maya"), false);
  assert.equal(f.rows.find((row) => row.type === "community_post_created").fromUserID, "community");
});

test("post replays preserve read state and do not duplicate activities", async () => {
  const f = fixture();
  await f.notify("post");
  const inbox = f.rows.find((row) => row.type === "community_admin_inbox");
  inbox.isRead = true;
  const preview = f.rows.find((row) => row.type === "community_admin_activity");
  await f.notify("post");
  assert.equal(f.rows.filter((row) => row.type === "community_admin_inbox").length, 1);
  assert.equal(inbox.isRead, true);
  assert.equal(f.rows.find((row) => row.type === "community_admin_activity").notificationID, preview.notificationID);
});

test("each fresh post updates one preview with the complete unread total", async () => {
  const f = fixture();
  await f.notify("post");
  const oldID = f.rows.find((row) => row.type === "community_admin_activity").notificationID;
  f.setTime("2026-10-28T00:00:00.001Z");
  f.setPost({ post_id: "next", realm_id: "club", community_entity_id: "community", community_name: "Garden Club", author_id: "maya", handle: "maya", is_anonymous: false });
  await f.notify("next");
  const previews = f.rows.filter((row) => row.type === "community_admin_activity");
  assert.equal(previews.length, 1);
  assert.notEqual(previews[0].notificationID, oldID);
  assert.equal(previews[0].content.details, "2 new activities in your community. Check them out.");
});

test("noncommunity/deleted posts do nothing and revoked managers get no preview", async () => {
  const f = fixture(); f.setPost(null);
  await f.notify("absent");
  assert.equal(f.rows.length, 0);
  const g = fixture(); g.revoke();
  await g.notify("post");
  assert.equal(g.rows.some((row) => row.type === "community_admin_activity"), false);
});

test("notification IDs match the Django UUID5 contract", () => {
  assert.equal(noticeID("post", "community", "community_post_created"), "NTF_community_admin_7dd6c6b6-574f-5cee-98a1-806aa1c34406");
});

test("overlapping activity in the same millisecond cannot replace a newer unread total", async () => {
  const f = fixture();
  const originalCount = f.notifications.countDocuments;
  let release;
  let paused;
  const counted = new Promise((resolve) => { paused = resolve; });
  const resume = new Promise((resolve) => { release = resolve; });
  let first = true;
  f.notifications.countDocuments = async (query) => {
    const count = await originalCount(query);
    if (first) {
      first = false;
      paused();
      await resume;
    }
    return count;
  };
  const older = f.notify("post");
  await counted;
  f.setPost({ post_id: "next", realm_id: "club", community_entity_id: "community", community_name: "Garden Club", author_id: "maya", handle: "maya", is_anonymous: false });
  await f.notify("next");
  release();
  await older;
  const previews = f.rows.filter((row) => row.type === "community_admin_activity");
  assert.equal(previews.length, 1);
  assert.equal(previews[0].content.details, "2 new activities in your community. Check them out.");
});
