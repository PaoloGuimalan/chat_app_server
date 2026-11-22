const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function api() {
  assert.ok(fs.existsSync(path.join(__dirname, 'realmLifecycleEvents.js')), 'Lifecycle call cleanup is missing');
  return require('./realmLifecycleEvents');
}

test('concurrent room creation keeps one router available for lifecycle cleanup', async () => {
  const { createRoomRegistry } = api();
  assert.equal(typeof createRoomRegistry, 'function');
  const rooms = new Map();
  const registry = createRoomRegistry(rooms);
  let creations = 0;
  const factory = async () => { creations++; await Promise.resolve(); return { router: 'one' }; };
  const [first, second] = await Promise.all([registry('room', factory), registry('room', factory)]);
  assert.equal(creations, 1);
  assert.equal(first, second);
  assert.equal(rooms.get('room'), first);
});

test('hosting-pod admission rejects an old relay after deactivation without breaking personal calls', async () => {
  const { guardRealmAction } = api();
  assert.equal(typeof guardRealmAction, 'function');
  let effects = 0;
  const inactive = { query: async () => ({ rows: [{ id: 'realm', lookup_id: 'realm', start_id: 'realm', parent_id: null, is_active: false }] }) };
  await assert.rejects(guardRealmAction(inactive, 'realm', async () => effects++), /unavailable/i);
  assert.equal(effects, 0);
  await guardRealmAction({ query: async () => ({ rows: [] }) }, 'dm', async () => effects++, {personalConversation:async()=>true});
  assert.equal(effects, 1);
});

test('a delayed relay for a deleted realm cannot manufacture a personal room',async()=>{
 const {guardRealmAction}=api();let rooms=0;
 await assert.rejects(guardRealmAction({query:async()=>({rows:[]})},'deleted',async()=>rooms++,{personalConversation:async()=>false}),/unavailable/);
 assert.equal(rooms,0);
});

test('local lifecycle disposal closes media and clears only the selected room', async () => {
  const { disposeLocalRoom } = api();
  const producer = { closed: false, close() { this.closed = true; } };
  const transport = { closed: false, close() { this.closed = true; } };
  const router = { closed: false, close() { this.closed = true; } };
  const rooms = new Map([['room', { producers: new Map([['p', producer]]), transports: new Map([['t', { transport }]]), router }], ['sibling', {}]]);
  const metadata = new Set(['room', 'sibling']);
  const options = { rooms, roomState: { deleteRoom: async id => metadata.delete(id) },
    clearParticipants: async () => {}, cleanupPipes: async () => {}, clearTimers: () => {} };
  await disposeLocalRoom('room', options);
  await disposeLocalRoom('room', options);
  assert.equal(producer.closed, true); assert.equal(transport.closed, true); assert.equal(router.closed, true);
  assert.deepEqual([...rooms.keys()], ['sibling']);
  assert.deepEqual([...metadata], ['sibling']);
});

test('late events cannot close a reactivated room; disabled scope closes real local descendants', async () => {
  const { createRealmLifecycleController } = api();
  let active = true;
  const closed = [];
  const rooms = new Map([['child', { realmID: 'child' }], ['sibling', { realmID: 'sibling' }]]);
  const client = { query: async sql => ({ rows: sql.includes('SELECT * FROM ancestry')
    ? [{ id: 'server', lookup_id: 'server', start_id: 'server', parent_id: null, is_active: active }]
    : [{ id: 'server' }, { id: 'child' }] }) };
  const controller = createRealmLifecycleController({ client, rooms,
    closeLocal: async id => { closed.push(id); rooms.delete(id); },
    roomState: { getRoomPod: async id => id === 'child' ? 'local' : null }, relay: async () => {}, podName: 'local' });
  await controller.onEvent('server');
  assert.deepEqual(closed, []);
  active = false;
  await controller.onEvent('server');
  assert.deepEqual(closed, ['child']);
  assert.deepEqual([...rooms.keys()], ['sibling']);
});

test('remote hosting pods receive a relay rather than a false local closure', async () => {
  const { createRealmLifecycleController } = api();
  const relays = [];
  const controller = createRealmLifecycleController({ client: {}, rooms: new Map(),
    closeLocal: async () => assert.fail('remote media is not local'),
    roomState: { getRoomPod: async () => 'remote' }, relay: async (...args) => relays.push(args), podName: 'local' });
  await controller.closeRealmRooms(['room']);
  assert.equal(relays[0][0], 'remote');
  assert.equal(relays[0][2].realm_id, 'room');
});

test('missed-event sweep preserves personal calls and never treats SQL outage as revocation', async () => {
  const { createRealmLifecycleController } = api();
  const rooms = new Map([['realm', { realmID: 'realm' }], ['personal', { realmID: null }]]);
  let fail = true;
  const controller = createRealmLifecycleController({ rooms, client: { query: async () => {
    if (fail) throw new Error('unavailable database');
    return { rows: [] };
  } }, closeLocal: async id => rooms.delete(id) });
  await assert.rejects(controller.sweep(), /database/);
  assert.equal(rooms.size, 2);
  fail = false;
  await controller.sweep();
  assert.deepEqual([...rooms.keys()], ['personal']);
});

test('failed metadata cleanup is retried even after native media is removed', async () => {
  const { createRealmLifecycleController } = api();
  const rooms = new Map([['room', { realmID: 'room' }]]);
  let failed = true;
  const metadata = new Set(['room']);
  const controller = createRealmLifecycleController({ rooms,
    client: { query: async () => ({ rows: [] }) },
    closeLocal: async id => { rooms.delete(id); if (failed) throw new Error('Redis offline'); metadata.delete(id); },
    roomState: { getRoomPod: async () => 'local' }, podName: 'local' });
  await assert.rejects(controller.closeRealmRooms(['room']), /offline/);
  failed = false;
  await controller.sweep();
  assert.equal(rooms.size, 0);
  assert.equal(metadata.size, 0);
});
