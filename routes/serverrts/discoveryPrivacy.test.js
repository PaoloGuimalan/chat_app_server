const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

test("discovering private servers never grants access to their roster", async () => {
  const source = fs.readFileSync(require.resolve("./index"), "utf8");
  const start = source.indexOf('router.get("/getservermembers/:serverID"');
  const end = source.indexOf("router.put(", start);
  for (const realm of [
    null,
    { is_private: true, has_access: false },
    { is_private: true, has_access: true },
    { is_private: false, has_access: false },
  ]) {
    let handler;
    let rosterReads = 0;
    const context = {
      router: {
        get: (_path, _auth, callback) => {
          handler = callback;
        },
      },
      jwtchecker() {},
      JWT_SECRET: "fixture",
      jwt: { sign: () => "signed" },
      pool: {
        query: async (_sql, params) => {
          assert.deepEqual(Array.from(params), ["server", "viewer"]);
          return { rows: realm ? [realm] : [] };
        },
      },
      GetServerMembers: async () => {
        rosterReads++;
        return [];
      },
    };
    vm.runInNewContext(source.slice(start, end), context);
    const response = {
      status(code) {
        this.code = code;
        return this;
      },
      send(body) {
        this.body = body;
      },
    };
    await handler(
      { params: { serverID: "server", entity_id: "viewer" } },
      response,
    );
    const allowed = Boolean(realm && (!realm.is_private || realm.has_access));
    assert.equal(response.body.status, allowed);
    assert.equal(rosterReads, allowed ? 1 : 0);
    if (!allowed) assert.equal(response.code, 403);
  }
});
