const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function access() {
  assert.ok(fs.existsSync(path.join(__dirname, 'realmAccess.js')), 'Effective realm access is missing');
  return require('./realmAccess');
}
const root = { id: 'server', realm_id: 'server', parent_id: null, is_active: true, deletion_requested_at: null };
const child = { id: 'channel', realm_id: 'channel', parent_id: 'server', is_active: true, deletion_requested_at: null };

test('an expected realm that disappeared cannot become a personal write', async()=>{
 const {withActiveRealmWrite}=access();let writes=0;
 const client={query:async()=>({rows:[]}),release(){}};
 await assert.rejects(withActiveRealmWrite({connect:async()=>client},['gone'],async()=>writes++,{requiredRealmIDs:['gone']}),/unavailable/);
 assert.equal(writes,0);
});

test('checking personal recipients uses one batch lookup, not a lookup per recipient', async () => {
  const { lockActiveRealmScopes } = access();
  let reads = 0;
  await lockActiveRealmScopes({ query: async () => { reads++; return { rows: [] }; } },
    Array.from({ length: 25 }, (_, index) => `person-${index}`));
  assert.equal(reads, 1);
});

test('pinned transaction guard rejects inactive source without opening another connection', async () => {
  const { lockActiveRealmScopes } = access();
  assert.equal(typeof lockActiveRealmScopes, 'function');
  const client = { query: async () => ({ rows: [{ ...root, lookup_id: 'server', start_id: 'server', is_active: false }] }) };
  await assert.rejects(lockActiveRealmScopes(client, ['server']), /unavailable/);
});

test('active child is blocked by inactive/deleting parents and invalid hierarchy', async () => {
  const { evaluateRealmRows } = access();
  for (const parent of [{ ...root, is_active: false }, { ...root, deletion_requested_at: new Date() }]) {
    assert.equal(evaluateRealmRows([child, parent], 'channel').allowed, false);
  }
  assert.equal(evaluateRealmRows([child, root], 'channel').allowed, true);
  assert.equal(evaluateRealmRows([child], 'channel').reason, 'invalid_hierarchy');
  assert.equal(evaluateRealmRows([child, { ...root, parent_id: 'channel' }], 'channel').reason, 'invalid_hierarchy');
  assert.equal(evaluateRealmRows([{ ...child, is_active: false }, root], 'channel').allowed, false);
});

test('missing realm is distinct from an authorized personal conversation', async () => {
  const { realmAccess } = access();
  const result = await realmAccess({ query: async () => ({ rows: [] }) }, 'personal-dm');
  assert.equal(result.found, false);
  assert.equal(result.allowed, false);
});

test('inactive leaves retain their complete root-first lock scope', () => {
  const { evaluateRealmRows } = access();
  const result = evaluateRealmRows([{ ...child, is_active: false }, root], 'channel');
  assert.equal(result.rootID, 'server');
  assert.deepEqual(result.chain, ['channel', 'server']);
});

test('cleanup can hold inactive scope locks without granting ordinary writes', async () => {
  const { withRealmScopeRead } = access();
  assert.equal(typeof withRealmScopeRead, 'function');
  const events = [];
  const client = { query: async (sql, params) => {
    events.push(sql.includes('FOR SHARE') ? `lock:${params[0]}` : sql);
    return { rows: sql.includes('WITH RECURSIVE') ? [{ ...child, is_active: false, lookup_id: 'channel', start_id: 'channel' }, { ...root, lookup_id: 'channel', start_id: 'channel' }] : [] };
  }, release() {} };
  await withRealmScopeRead({ connect: async () => client }, ['channel'], async () => events.push('cleanup'));
  assert.ok(events.indexOf('lock:server') < events.indexOf('lock:channel'));
  assert.ok(events.indexOf('lock:channel') < events.indexOf('cleanup'));
});

test('mutations roll back without side effects when lifecycle access is lost', async () => {
  const { withActiveRealmWrite } = access();
  const sql = [];
  let released = false;
  const client = { query: async (query) => {
    sql.push(query);
    return { rows: query.includes('WITH RECURSIVE') ? [{ ...root, lookup_id: root.id, start_id: root.id, is_active: false }] : [] };
  }, release: () => { released = true; } };
  let writes = 0;
  await assert.rejects(withActiveRealmWrite({ connect: async () => client }, ['server'], async () => writes++), /unavailable/i);
  assert.equal(writes, 0);
  assert.ok(sql.includes('ROLLBACK'));
  assert.equal(released, true);
});

test('active writes hold parent then child locks until their side effect completes', async () => {
  const { withActiveRealmWrite } = access();
  const events = [];
  const client = { query: async (sql, params) => {
    events.push(sql.includes('FOR SHARE') ? `lock:${params[0]}` : sql.startsWith('WITH') ? 'read' : sql);
    return { rows: sql.includes('WITH RECURSIVE') ? [{ ...child, lookup_id: 'channel', start_id: 'channel' }, { ...root, lookup_id: 'channel', start_id: 'channel' }] : [] };
  }, release: () => events.push('release') };
  await withActiveRealmWrite({ connect: async () => client }, ['channel'], async () => events.push('write'));
  assert.ok(events.indexOf('lock:server') < events.indexOf('lock:channel'));
  assert.ok(events.indexOf('lock:channel') < events.indexOf('write'));
  assert.ok(events.indexOf('write') < events.indexOf('COMMIT'));
  assert.equal(events.at(-1), 'release');
});
