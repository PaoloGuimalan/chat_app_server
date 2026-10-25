const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("notification senders retain community kind without changing page identities", async () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../../routes/users/index.js"),
    "utf8",
  );
  const start = source.indexOf("const enrichNotificationSenders =");
  const end = source.indexOf("const attachNotificationSenders =", start);
  let query;
  const resolve = vm.runInNewContext(
    `${source.slice(start, end)}; enrichNotificationSenders;`,
    {
      pool: {
        query: async (sql) => {
          query = sql;
          return {
            rows: ["community", "page"].map((kind) => ({
              entity_id: kind,
              type: "realm",
              realm_type: kind,
              display_name: kind,
              handle: kind,
              is_verified: true,
            })),
          };
        },
      },
    },
  );
  const senders = await resolve([[{ fromUserID: "community" }, { fromUserID: "page" }]]);
  assert.match(query, /r\.type AS realm_type/);
  assert.equal(senders.get("community").realm_type, "community");
  assert.equal(senders.get("page").realm_type, "page");
  assert.equal(senders.get("community").is_verified, true);
});
