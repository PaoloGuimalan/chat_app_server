const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('channel creation checks current authorization before loading or writing channel membership', async () => {
  const source = fs.readFileSync(require.resolve('./index'), 'utf8');
  const start = source.indexOf('router.post("/createchannel"');
  const end = source.indexOf('\nrouter.', start + 1);
  let handler, touched = false;
  vm.runInNewContext(source.slice(start, end < 0 ? undefined : end), {
    router: { post(_path, _auth, callback) { handler = callback; } }, jwtchecker() {},
    jwt: { verify: () => ({ serverID:'server', otherUsers:[], privacy:true, type:'channel', groupName:'Channel' }) },
    JWT_SECRET:'test', hasPermission: async (_actor, _code, _realm, options) => !options?.fresh,
    GetServerMembers: async () => { touched = true; return []; },
    createRealmReusable: async () => { touched = true; }, console: { log() {}, error() {} },
  });
  const response = { status(code) { this.code = code; return this; }, send(body) { this.body = body; } };
  await handler({ params:{entity_id:'actor'}, body:{token:'fixture'} }, response);
  assert.equal(response.code, 403);
  assert.equal(touched, false);
});
