const { activeRealmSQL, realmAccess, unavailable } = require('./realmAccess');

async function personalConversation(client, id) {
  const {rows}=await client.query('SELECT connection_id FROM entity_connection WHERE connection_id=$1 LIMIT 1',[id]);
  if(rows.length)return true;
  const Conversations=require('../../schema/messages/conversation');
  return Boolean(await Conversations.exists({conversationID:id,conversationType:'single'}));
}

async function guardRealmAction(client, conversationID, action, options = {}) {
  const access = await realmAccess(client, conversationID);
  if (access.found && !access.allowed) throw unavailable();
  if (!access.found && !await (options.personalConversation || personalConversation)(client,conversationID)) throw unavailable();
  return action();
}

function createRoomRegistry(rooms) {
  const pending = new Map();
  return async function getOrCreate(id, factory) {
    if (rooms.has(id)) return rooms.get(id);
    if (!pending.has(id)) pending.set(id, Promise.resolve().then(factory).then(room => {
      rooms.set(id, room);
      return room;
    }).finally(() => pending.delete(id)));
    return pending.get(id);
  };
}

async function disposeLocalRoom(id, { rooms, roomState, clearParticipants, cleanupPipes, clearTimers }) {
  const room = rooms.get(id);
  // Remove registry ownership before asynchronous cleanup or transport callbacks.
  rooms.delete(id);
  clearTimers(id);
  if (room) {
    for (const producer of room.producers.values()) producer.close();
    for (const entry of room.transports.values()) entry.transport.close();
    room.router.close();
  }
  // These operations are idempotent; retry even if local media was already closed.
  await cleanupPipes(id);
  await roomState.deleteRoom(id);
  await clearParticipants(id);
}

function createRealmLifecycleController({ client, rooms, closeLocal, roomState, relay, podName }) {
  const pendingCleanup = new Map();
  async function closeHere(id) {
    pendingCleanup.set(id, rooms.get(id)?.realmID || id);
    await closeLocal(id);
    pendingCleanup.delete(id);
  }
  async function closeRealmRooms(ids) {
    for (const id of ids) {
      if (rooms.has(id) || pendingCleanup.has(id)) await closeHere(id);
      else {
        const owner = await roomState.getRoomPod(id);
        if (owner === podName) await closeHere(id);
        else if (owner) await relay(owner, 'realm-lifecycle-relay', { realm_id: id });
      }
    }
  }
  async function onEvent(realmID) {
    const current = await realmAccess(client, realmID);
    if (!current.found || current.allowed) return;
    const { rows } = await client.query(`WITH RECURSIVE scope AS (
      SELECT id FROM community_realm WHERE id = $1
      UNION SELECT child.id FROM community_realm child JOIN scope parent ON child.parent_id = parent.id
    ) SELECT id FROM scope`, [realmID]);
    await closeRealmRooms(rows.map(row => String(row.id)));
  }
  async function sweep() {
    const candidates = new Map([...rooms.entries()].filter(([, room]) => room.realmID));
    for (const [id, realmID] of pendingCleanup) if (!candidates.has(id)) candidates.set(id, { realmID });
    const entries = [...candidates];
    if (!entries.length) return;
    const ids = [...new Set(entries.map(([, room]) => room.realmID))];
    const { rows } = await client.query(`SELECT r.id FROM community_realm r
      WHERE r.id = ANY($1::text[]) AND ${activeRealmSQL('r')}`, [ids]);
    const active = new Set(rows.map(row => String(row.id)));
    for (const [id, room] of entries) if (!active.has(String(room.realmID)) || pendingCleanup.has(id)) await closeHere(id);
  }
  return { closeRealmRooms, onEvent, sweep };
}

module.exports = { disposeLocalRoom, createRealmLifecycleController, createRoomRegistry, guardRealmAction, personalConversation };
