const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { assertMessagingTarget } = require('../../reusables/models/realmCapabilities');

test('disabled server initialization denies access before reading channel messages', async () => {
  const source = fs.readFileSync(require.resolve('./index'), 'utf8');
  const start = source.indexOf('router.get("/initserverchannels/:serverID"');
  const end = source.indexOf('router.post("/addnewmembertoserver"', start);
  let handler, messageReads = 0;
  const pool = { query: async () => ({ rows: [{ id: 'server', entity_id: 'server-entity', type: 'server',
    is_active: false, deletion_requested_at: null, parent_id: null }] }) };
  const context = { router: { get(_path, _auth, fn) { handler = fn; } }, jwtchecker() {}, pool,
    assertMessagingTarget, roleTierSQL: () => "'owner'", configurationCapabilities: async () => ({}),
    hasPermission: async () => false, jwt: { sign: data => data }, JWT_SECRET: 'fixture',
    UserMessage: { aggregate: async () => { messageReads++; return []; } }, console: { error() {}, log() {} } };
  vm.runInNewContext(source.slice(start, end), context);
  const response = { code: null, body: null, status(code) { this.code = code; return this; }, send(body) { this.body = body; } };
  await handler({ params: { serverID: 'server', entity_id: 'owner' } }, response).catch(() => {});
  assert.equal(response.code, 403);
  assert.equal(messageReads, 0);
});

test('ownership cannot move to an inactive page while its deletion is pending', async () => {
  const source = fs.readFileSync(require.resolve('./index'), 'utf8');
  const start = source.indexOf('router.put("/transfer-realm-ownership"');
  const end = source.indexOf('module.exports = router', start);
  let handler, ownerWrites = 0;
  const client = { release() {}, query: async sql => {
    if (sql.includes('FROM community_realm')) return { rows: [{ id: 'page', type: 'page', is_active: false, parent_id: null }] };
    if (sql.startsWith('SELECT m.entity_id')) return { rows: [{ entity_id: 'page-entity', role: 'member' }] };
    if (sql.includes('UPDATE community_member')) ownerWrites++;
    return { rows: [] };
  } };
  const context = { router: { put(_path, _auth, fn) { handler = fn; } }, jwtchecker() {},
    pool: { getPool: () => ({ connect: async () => client }), query: async () => ({ rows: [] }) },
    assertMessagingTarget, assertCanTransferOwnership: async () => {}, hasPermission: async () => true,
    realmOwnerRoleID: async () => 1, resolveRole: async () => ({ id: 2 }), roleTierSQL: () => "'member'",
    publish() {}, console: { error() {}, log() {} } };
  vm.runInNewContext(source.slice(start, end), context);
  const response = { status(code) { this.code = code; return this; }, send(body) { this.body = body; } };
  await handler({ params: { entity_id: 'owner' }, body: { realm_id: 'server', member_id: 'page-member' } }, response);
  assert.equal(response.code, 403);
  assert.equal(ownerWrites, 0);
});
