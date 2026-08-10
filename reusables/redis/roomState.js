/**
 * roomState.js
 *
 * Redis-backed metadata store for WebRTC room state.
 *
 * Key schema (all scoped to conversationID):
 *
 *   call:members:{conversationID}
 *     Hash  — clientId -> JSON { userId, username }
 *
 *   call:status:{conversationID}
 *     Hash  — clientId -> JSON { muted, cameraOff }
 *
 *   call:producers:{conversationID}
 *     Hash  — producerId -> JSON { clientId, kind, source, rtpParameters }
 *
 *   call:room:pod:{conversationID}
 *     String — which pod owns this room's mediasoup router (the producer pod)
 *
 *   call:pod:ip:{podName}
 *     String — internal cluster IP of a pod, registered on startup
 *
 *   call:pipes:{conversationID}
 *     Hash  — "{fromPod}:{toPod}" -> JSON { localTransportId, remoteTransportId }
 *             Tracks established PipeTransport pairs so we don't recreate them
 *
 * TTL policy:
 *   All keys are refreshed to ROOM_TTL_SEC on every write.
 *   If a pod dies, keys expire automatically — no leaked state.
 */

const ROOM_TTL_SEC = 60 * 60; // 1 hour max room lifetime

let publisher; // shared redis client — set via init()

function init(redisClient) {
  publisher = redisClient;
}

// ─── Key helpers ────────────────────────────────────────────────────────────

const keys = {
  members:   (id) => `call:members:${id}`,
  status:    (id) => `call:status:${id}`,
  producers: (id) => `call:producers:${id}`,
  pod:       (id) => `call:room:pod:${id}`,
  podIp:     (podName) => `call:pod:ip:${podName}`,
  pipes:     (id) => `call:pipes:${id}`,
};

// Refresh TTL on all keys for a room to keep active rooms alive
async function touchRoom(conversationID) {
  if (!publisher) return;
  await Promise.all([
    publisher.expire(keys.members(conversationID),   ROOM_TTL_SEC),
    publisher.expire(keys.status(conversationID),    ROOM_TTL_SEC),
    publisher.expire(keys.producers(conversationID), ROOM_TTL_SEC),
  ]);
}

// ─── Pod ownership ──────────────────────────────────────────────────────────

async function setRoomPod(conversationID, podName) {
  if (!publisher) return;
  await publisher.set(keys.pod(conversationID), podName, { EX: ROOM_TTL_SEC });
}

async function getRoomPod(conversationID) {
  if (!publisher) return null;
  return publisher.get(keys.pod(conversationID));
}

async function deleteRoomPod(conversationID) {
  if (!publisher) return;
  await publisher.del(keys.pod(conversationID));
}

// ─── Members ────────────────────────────────────────────────────────────────

async function setMember(conversationID, clientId, data) {
  if (!publisher) return;
  await publisher.hSet(keys.members(conversationID), clientId, JSON.stringify(data));
  await touchRoom(conversationID);
}

async function getMember(conversationID, clientId) {
  if (!publisher) return null;
  const raw = await publisher.hGet(keys.members(conversationID), clientId);
  return raw ? JSON.parse(raw) : null;
}

async function getAllMembers(conversationID) {
  if (!publisher) return {};
  const raw = await publisher.hGetAll(keys.members(conversationID));
  if (!raw) return {};
  const result = {};
  for (const [clientId, val] of Object.entries(raw)) {
    result[clientId] = JSON.parse(val);
  }
  return result;
}

async function deleteMember(conversationID, clientId) {
  if (!publisher) return;
  await publisher.hDel(keys.members(conversationID), clientId);
  // Also clean up their status
  await publisher.hDel(keys.status(conversationID), clientId);
}

async function hasMember(conversationID, clientId) {
  if (!publisher) return false;
  return publisher.hExists(keys.members(conversationID), clientId);
}

async function getMemberCount(conversationID) {
  if (!publisher) return 0;
  return publisher.hLen(keys.members(conversationID));
}

// ─── Member status (muted / cameraOff) ──────────────────────────────────────

async function setMemberStatus(conversationID, clientId, status) {
  if (!publisher) return;
  await publisher.hSet(keys.status(conversationID), clientId, JSON.stringify(status));
  await touchRoom(conversationID);
}

async function getMemberStatus(conversationID, clientId) {
  if (!publisher) return { muted: false, cameraOff: false };
  const raw = await publisher.hGet(keys.status(conversationID), clientId);
  return raw ? JSON.parse(raw) : { muted: false, cameraOff: false };
}

async function getAllMemberStatuses(conversationID) {
  if (!publisher) return {};
  const raw = await publisher.hGetAll(keys.status(conversationID));
  if (!raw) return {};
  const result = {};
  for (const [clientId, val] of Object.entries(raw)) {
    result[clientId] = JSON.parse(val);
  }
  return result;
}

// ─── Producers ──────────────────────────────────────────────────────────────

async function setProducerMeta(conversationID, producerId, meta) {
  if (!publisher) return;
  await publisher.hSet(keys.producers(conversationID), producerId, JSON.stringify(meta));
  await touchRoom(conversationID);
}

async function getProducerMeta(conversationID, producerId) {
  if (!publisher) return null;
  const raw = await publisher.hGet(keys.producers(conversationID), producerId);
  return raw ? JSON.parse(raw) : null;
}

async function getAllProducerMeta(conversationID) {
  if (!publisher) return {};
  const raw = await publisher.hGetAll(keys.producers(conversationID));
  if (!raw) return {};
  const result = {};
  for (const [producerId, val] of Object.entries(raw)) {
    result[producerId] = JSON.parse(val);
  }
  return result;
}

async function deleteProducerMeta(conversationID, producerId) {
  if (!publisher) return;
  await publisher.hDel(keys.producers(conversationID), producerId);
}

async function deleteAllProducerMetaForClient(conversationID, clientId) {
  if (!publisher) return [];
  const all = await getAllProducerMeta(conversationID);
  const owned = Object.entries(all)
    .filter(([, meta]) => meta.clientId === clientId)
    .map(([producerId]) => producerId);

  if (owned.length > 0) {
    await publisher.hDel(keys.producers(conversationID), owned);
  }
  return owned;
}

// ─── Full room cleanup ───────────────────────────────────────────────────────

async function deleteRoom(conversationID) {
  if (!publisher) return;
  await Promise.all([
    publisher.del(keys.members(conversationID)),
    publisher.del(keys.status(conversationID)),
    publisher.del(keys.producers(conversationID)),
    publisher.del(keys.pod(conversationID)),
    publisher.del(keys.pipes(conversationID)),
  ]);
  console.log(`[roomState] Deleted all Redis state for room: ${conversationID}`);
}

// ─── Pod IP registry ─────────────────────────────────────────────────────────
// Each pod registers its internal cluster IP on startup so other pods can
// open PipeTransport connections to it by name.

const POD_IP_TTL_SEC = 60 * 60 * 24; // 24 hours — refreshed on every startup

async function registerPodIp(podName, ip) {
  if (!publisher) return;
  await publisher.set(keys.podIp(podName), ip, { EX: POD_IP_TTL_SEC });
}

async function getPodIp(podName) {
  if (!publisher) return null;
  return publisher.get(keys.podIp(podName));
}

// ─── Pipe transport registry ─────────────────────────────────────────────────
// Tracks established PipeTransport pairs between pods for a given room.
// Key format: "{fromPod}:{toPod}" so both directions are explicit.

async function setPipeEntry(conversationID, fromPod, toPod, entry) {
  if (!publisher) return;
  const field = `${fromPod}:${toPod}`;
  await publisher.hSet(keys.pipes(conversationID), field, JSON.stringify(entry));
  await publisher.expire(keys.pipes(conversationID), ROOM_TTL_SEC);
}

async function getPipeEntry(conversationID, fromPod, toPod) {
  if (!publisher) return null;
  const field = `${fromPod}:${toPod}`;
  const raw = await publisher.hGet(keys.pipes(conversationID), field);
  return raw ? JSON.parse(raw) : null;
}

async function deletePipes(conversationID) {
  if (!publisher) return;
  await publisher.del(keys.pipes(conversationID));
}

module.exports = {
  init,
  // Exported for the periodic room keepalive in webRTC.js - the writes below
  // call it themselves, but they only fire on joins, status changes and new
  // producers, which a settled call can go hours without.
  touchRoom,
  setRoomPod,
  getRoomPod,
  deleteRoomPod,
  setMember,
  getMember,
  getAllMembers,
  deleteMember,
  hasMember,
  getMemberCount,
  setMemberStatus,
  getMemberStatus,
  getAllMemberStatuses,
  setProducerMeta,
  getProducerMeta,
  getAllProducerMeta,
  deleteProducerMeta,
  deleteAllProducerMetaForClient,
  deleteRoom,
  registerPodIp,
  getPodIp,
  setPipeEntry,
  getPipeEntry,
  deletePipes,
};
