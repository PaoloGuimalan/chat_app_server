const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const { canActAsEntity } = require("../models/actingIdentity");

test("personal requests never query realm grants; switched requests recheck SQL every time", async () => {
  let permitted = true, reads = 0;
  const client = { async query(sql, values) { reads++; assert.deepEqual(values, ["personal", "realm"]);
    return { rows: permitted ? [{ id: "realm" }] : [] }; } };
  assert.equal(await canActAsEntity("personal", "personal", client), true);
  assert.equal(reads, 0);
  assert.equal(await canActAsEntity("personal", "realm", client), true);
  permitted = false;
  assert.equal(await canActAsEntity("personal", "realm", client), false);
  assert.equal(reads, 2);
});

function middleware(allowed) {
  const calls = { sessions: 0, next: 0, authority: 0 };
  const context = { module: { exports: {} }, process: { env: {} }, console,
    require(name) {
      if (name === "dotenv") return { config() {} };
      if (name === "jsonwebtoken") return { verify(token, secret, callback) {
        if (!callback) return { token: "inner", type: "notifications", deviceToken: "device" };
        return callback(null, { userID: "user", entity: "realm", hash: "hash" });
      } };
      if (name === "../models/actingIdentity") return { async canActAsEntity(personal, acting) {
        calls.authority++; assert.equal(personal, "personal"); assert.equal(acting, "realm"); if (allowed instanceof Error) throw allowed; return allowed;
      } };
      if (name === "../../schema/auth/sessions") return { async findOne() { calls.sessions++; return {}; } };
      if (name === "../database/postgres") return { async query(sql) { return { rows: sql.startsWith("SELECT name") ? [{name: "Garden Club"}] : [{ id: "user", entity_id: "personal" }] }; } };
      if (name === "./crypto") return { decryptNonce: () => ({ timestamp: Math.floor(Date.now()/1000) }), matchesDeviceHash: () => true };
      if (name === "../redis/pubsub") return { isUniqueNonce: async () => true };
      return {};
    } };
  vm.runInNewContext(fs.readFileSync(require.resolve("./jwthelper"), "utf8"), context);
  return { checker: context.module.exports, calls };
}
for (const sse of [false, true]) {
  test(`revoked acting permission blocks ${sse ? 'SSE' : 'HTTP'} with an already-issued token`, async () => {
    const { checker, calls } = middleware(false);
    const req = { params: { token: "outer" }, headers: { origin: "origin", "x-nonce": "nonce", "device-token": "device", "x-access-token": "token" } };
    let code, finish;
    const completed = new Promise(resolve => finish = resolve);
    const res = { status(value) { code = value; return this; }, send(value) { finish(value); }, sse(type, value) { finish(value); } };
    await checker[sse ? "jwtssechecker" : "jwtchecker"](req, res, () => { calls.next++; finish({ auth: true }); });
    const response = await completed;
    assert.equal(calls.authority, 1); assert.equal(calls.next, 0); assert.equal(calls.sessions, 0);
    assert.equal(response.auth, false);
    assert.equal(response.code, "REALM_ACCESS_REVOKED");
    assert.equal(response.message, "Your access to Garden Club was revoked.");
  });
}

for (const sse of [false,true]) {
  test(`database failure blocks ${sse ? 'SSE' : 'HTTP'} without falsely revoking identity`, async()=>{
    const {checker,calls}=middleware(new Error('SQL unavailable'));
    let finish,code;
    const completed=new Promise(resolve=>finish=resolve);
    const response={status(value){code=value;return this;},send:finish,sse(type,body){finish(body);}};
    await checker[sse?'jwtssechecker':'jwtchecker']({params:{token:'outer'},headers:{origin:'origin','x-access-token':'token','device-token':'device','x-nonce':'nonce'}},response,()=>{calls.next++;finish({});});
    const body=await completed;assert.equal(body.code,undefined);assert.equal(calls.next,0);
    if(!sse) assert.equal(code,503);
  });
}
