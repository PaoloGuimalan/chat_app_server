require("dotenv").config();
const os = require("os");
const mediasoup = require("mediasoup");
const {
  publish,
  removeParticipant,
  touchParticipants,
} = require("../redis/pubsub");
const rs = require("../redis/roomState");
const pipeManager = require("./pipeManager");

const POD_NAME = process.env.POD_NAME || process.env.HOSTNAME || "podless";

// ─── Worker pool ─────────────────────────────────────────────────────────────
// One mediasoup Worker per CPU core. Workers are native C++ processes —
// they cannot be serialized or shared across pods. They stay in-process only.

let workers = [];
let workerIndex = 0;
let workersReady = false;
let workersReadyResolve;
const workersReadyPromise = new Promise((resolve) => {
  workersReadyResolve = resolve;
});

async function spawnWorker(index) {
  const w = await mediasoup.createWorker({
    logLevel: "warn",
    rtcMinPort: 10000 + index * 100,
    rtcMaxPort: 10099 + index * 100,
  });

  w.on("died", async (error) => {
    console.error(`[WebRTC] Worker ${index} died — replacing:`, error);
    // Remove the dead worker from the pool immediately so no new rooms are assigned to it
    const pos = workers.indexOf(w);
    if (pos !== -1) workers.splice(pos, 1);

    // Spawn a replacement at the same index slot so the port range is reused
    try {
      const replacement = await spawnWorker(index);
      if (pos !== -1) {
        workers.splice(pos, 0, replacement);
      } else {
        workers.push(replacement);
      }
      console.log(`[WebRTC] Worker ${index} replaced successfully`);
    } catch (spawnErr) {
      console.error(`[WebRTC] Failed to replace worker ${index}:`, spawnErr);
    }
  });

  return w;
}

(async () => {
  const numCores = os.cpus().length;
  for (let i = 0; i < numCores; i++) {
    const w = await spawnWorker(i);
    workers.push(w);
  }
  workersReady = true;
  workersReadyResolve();
  console.log(`[WebRTC] Initialized ${numCores} MediaSoup Worker(s)`);
})();

function getNextWorker() {
  if (workers.length === 0) {
    throw new Error(
      "[WebRTC] No workers available — still initializing or all died",
    );
  }
  const w = workers[workerIndex % workers.length];
  workerIndex++;
  return w;
}

// ─── In-process room registry ─────────────────────────────────────────────────
// Holds ONLY live native mediasoup objects that cannot be serialized:
//   router     — mediasoup Router (bound to a Worker)
//   transports — Map: transportId -> { transport, clientId, userId, direction }
//   producers  — Map: producerId  -> mediasoup Producer object
//
// All serializable metadata (members, status, producerMeta) lives in Redis
// via roomState.js so it survives pod restarts and is visible across pods.

const nativeRooms = new Map(); // conversationID -> { router, transports, producers }

// Stale room cleanup — evict in-process state + Redis state after TTL
const EMPTY_ROOM_TTL_MS = 5 * 60 * 1000;
const emptyRoomTimers = new Map();

// ─── Room keepalive ──────────────────────────────────────────────────────────
//
// Every Redis key describing a room expires (ROOM_TTL_SEC / PARTICIPANTS_TTL_SEC),
// and until now the only thing that pushed those expiries out was a WRITE:
// touchRoom rides along on setMember / setMemberStatus / setProducerMeta. Those
// fire on joins, mute and camera toggles, and new producers - none of which a
// settled call is obliged to produce. Four people talking quietly for an hour
// with nobody joining, leaving or touching a control would have had their
// roster and presence records expire out from under them: the tiles would stay
// (the media never stops) while the channel row dropped to nobody in the room,
// and a later join would rebuild the roster from an empty hash.
//
// So liveness is asserted on a timer instead, off the one fact that actually
// means the room is alive: this pod still holds its router in memory. That also
// makes the TTLs do the job they were written for - a pod that DIES stops
// refreshing, and everything it left behind expires within the hour.
//
// An emptied room keeps getting touched for the few minutes before
// scheduleRoomCleanup evicts it, which is harmless: deleteRoom removes the keys
// outright rather than waiting for them to expire.
const ROOM_KEEPALIVE_MS = 5 * 60 * 1000;

const roomKeepaliveTimer = setInterval(async () => {
  for (const conversationID of nativeRooms.keys()) {
    await rs
      .touchRoom(conversationID)
      .catch((err) => console.error("[roomState] touchRoom error:", err));
    await touchParticipants(conversationID).catch((err) =>
      console.error("[pubsub] touchParticipants error:", err),
    );
  }
}, ROOM_KEEPALIVE_MS);

// Never the reason the process stays up - this is bookkeeping for rooms that
// only exist while the service is running anyway.
roomKeepaliveTimer.unref?.();

// ─── Dead-client detection ───────────────────────────────────────────────────
//
// A client that disappears without calling /leave-room — app force-stopped,
// process crashed, battery died, phone in a tunnel — used to leave everything
// behind: its roster entry (a stuck placeholder tile for everyone else), its
// entry in the `call:participants` presence hash (the "N in this room" count on
// a channel row), and its transports and producers on this pod. Nothing ever
// noticed, because the only callers of leaveRoom were the two HTTP endpoints.
//
// mediasoup already knows. WebRtcTransport runs ICE consent checks
// (iceConsentTimeout, default 30s) and emits `icestatechange` "disconnected"
// when they lapse; the transports here only ever listened for "routerclose",
// so the signal was thrown away. These handlers subscribe to what is already
// firing rather than adding any new mechanism.
//
// NOT an immediate leave: "disconnected" also fires on an ordinary network
// blip — a wifi-to-LTE handoff, a lift. Leaving on the first one would eject
// people who were about to recover, and since leaveRoom closes their producers,
// "recover" would mean a full rejoin. So a disconnect only ARMS a sweep, which
// any reconnection cancels.
const DISCONNECT_GRACE_MS = 20 * 1000;

// "conversationID|clientId" -> Timeout
const disconnectTimers = new Map();

const disconnectKey = (conversationID, clientId) =>
  `${conversationID}|${clientId}`;

function cancelDisconnectSweep(conversationID, clientId) {
  const key = disconnectKey(conversationID, clientId);
  const handle = disconnectTimers.get(key);
  if (!handle) return;
  clearTimeout(handle);
  disconnectTimers.delete(key);
}

/// Tells the whole conversation - not just the people currently in the room -
/// that a client is gone.
///
/// leaveRoom broadcasts `participant-left`, but only to remaining ROOM members,
/// which is what moves a tile off the call stage. The channel rows ("N in this
/// room", the voice-channel roster) are fed by a different event entirely,
/// `update_participants`, and until now the ONLY places that emitted it were
/// the /leave-room and /leave-room-keepalive HTTP routes. A client that dies
/// never calls either, so the sweep below cleaned Redis silently: the roster
/// was correct the moment anyone rejoined and re-read it, and wrong for
/// everyone already looking at it.
///
/// The recipient list mirrors the routes - every conversation member plus the
/// departing entity itself, so a user watching from another tab also updates.
async function announceParticipantRemoval(conversationID, entityID, clientId) {
  // Deferred require: models/messages pulls in a large chunk of the model
  // layer, and this is the only thing in here that needs it.
  const { GetAllReceivers } = require("../models/messages");

  const savedRecipients = await GetAllReceivers(conversationID).catch(() => ({
    users: [],
  }));
  const recipients = [
    ...new Set([
      ...savedRecipients.users.map((mp) => mp.entityID).filter(Boolean),
      entityID,
    ]),
  ];

  await Promise.all(
    recipients.map((mp) =>
      publish(`events_${mp}`, "update_participants", {
        status: true,
        auth: true,
        result: { clientId, action: "left" },
      }).catch(() => {}),
    ),
  );
}

/// Arms the grace timer for a client whose transport just went quiet.
///
/// First signal wins - a client has TWO transports (send and recv) and they
/// usually fail together, so the second must not restart the clock.
function scheduleDisconnectSweep(conversationID, entityID, clientId) {
  if (!conversationID || !clientId) return;
  const key = disconnectKey(conversationID, clientId);
  if (disconnectTimers.has(key)) return;

  const handle = setTimeout(async () => {
    disconnectTimers.delete(key);

    // Still a member? A clean leave, a rejoin under the same clientId, or an
    // eviction in the meantime all mean there is nothing left to sweep. The
    // check is against Redis rather than local state because the room may have
    // moved pods while we waited.
    const member = await rs
      .getMember(conversationID, clientId)
      .catch(() => null);
    if (!member) return;

    console.log(
      `[WebRTC] Dead client swept after ${DISCONNECT_GRACE_MS}ms: ` +
        `${clientId} in ${conversationID}`,
    );
    const leavingEntityID = member.entityID || entityID;

    // The same teardown a deliberate leave performs - roster entry, presence
    // record, producers, transports, and the participant-left broadcast that
    // moves it off everyone else's screen.
    await leaveRoom(conversationID, leavingEntityID, clientId).catch((err) =>
      console.error("[WebRTC] Dead-client sweep failed:", err),
    );

    // ...and the half of a deliberate leave that lives in the HTTP route,
    // which a dead client never reaches. Without this the presence lists
    // outside the call keep the ghost until something else rewrites them.
    await announceParticipantRemoval(
      conversationID,
      leavingEntityID,
      clientId,
    ).catch((err) =>
      console.error("[WebRTC] Dead-client sweep announce failed:", err),
    );
  }, DISCONNECT_GRACE_MS);

  disconnectTimers.set(key, handle);
}

// Give pipeManager access to routers and producers without circular imports
pipeManager.setRouterResolver(async (conversationID) => {
  const room = await getOrCreateNativeRoom(conversationID);
  return room.router;
});
pipeManager.setProducerResolver(async (conversationID, producerId) => {
  return nativeRooms.get(conversationID)?.producers.get(producerId) || null;
});

// ─── Codec config ────────────────────────────────────────────────────────────

const mediaCodecs = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
    parameters: {
      "sprop-stereo": 0,
      usedtx: 1, // discontinuous transmission — saves bandwidth during silence
      useinbandfec: 1, // forward error correction — recovers from packet loss
      maxplaybackrate: 48000,
      ptime: 20,
    },
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: { "x-google-start-bitrate": 800 },
  },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    parameters: {
      "packetization-mode": 1,
      "profile-level-id": "42e01f",
      "level-asymmetry-allowed": 1,
      "x-google-start-bitrate": 800,
    },
  },
];

const CAMERA_ENCODINGS = [
  { rid: "r0", maxBitrate: 150_000, scaleResolutionDownBy: 4 },
  { rid: "r1", maxBitrate: 400_000, scaleResolutionDownBy: 2 },
  { rid: "r2", maxBitrate: 900_000, scaleResolutionDownBy: 1 },
];

const SCREENSHARE_ENCODINGS = [
  { rid: "r0", maxBitrate: 1_500_000, scaleResolutionDownBy: 1 },
];

// ─── Room helpers ────────────────────────────────────────────────────────────

async function getOrCreateNativeRoom(conversationID) {
  // Ensure workers are initialized before creating any router
  if (!workersReady) await workersReadyPromise;

  if (!nativeRooms.has(conversationID)) {
    const worker = getNextWorker();
    const router = await worker.createRouter({ mediaCodecs });
    nativeRooms.set(conversationID, {
      router,
      transports: new Map(),
      producers: new Map(),
    });
    // Record which pod owns this room's router so other pods can relay correctly
    await rs
      .setRoomPod(conversationID, POD_NAME)
      .catch((err) => console.error("[roomState] setRoomPod error:", err));
  }
  return nativeRooms.get(conversationID);
}

function scheduleRoomCleanup(conversationID) {
  if (emptyRoomTimers.has(conversationID)) {
    clearTimeout(emptyRoomTimers.get(conversationID));
  }

  const handle = setTimeout(async () => {
    const memberCount = await rs.getMemberCount(conversationID).catch(() => 0);
    if (memberCount > 0) {
      emptyRoomTimers.delete(conversationID);
      return;
    }

    const room = nativeRooms.get(conversationID);
    if (room) {
      for (const [, producer] of room.producers.entries()) {
        try {
          producer.close();
        } catch (_) {
          /* no-op */
        }
      }
      for (const [, entry] of room.transports.entries()) {
        try {
          entry.transport.close();
        } catch (_) {
          /* no-op */
        }
      }
      nativeRooms.delete(conversationID);
    }

    await rs
      .deleteRoom(conversationID)
      .catch((err) => console.error("[roomState] deleteRoom error:", err));
    await pipeManager
      .cleanupPipesForRoom(conversationID)
      .catch((err) =>
        console.error("[PipeManager] cleanupPipesForRoom error:", err),
      );

    emptyRoomTimers.delete(conversationID);
    console.log(`[WebRTC] Stale room evicted: ${conversationID}`);
  }, EMPTY_ROOM_TTL_MS);

  emptyRoomTimers.set(conversationID, handle);
}

// ─── evictClientSession ───────────────────────────────────────────────────────
// Cleans up a client's stale native objects without broadcasting participant-left.
// Used by the reconnect flow so other participants don't see a leave/rejoin flash.

async function evictClientSession(conversationID, clientId) {
  // A reconnect under the same clientId is the client proving it is alive, so
  // any armed sweep is stale. Critically it must be cancelled BEFORE the new
  // session is built: otherwise the old session's timer fires 20s later,
  // finds a member under this clientId (the NEW one), and evicts a live
  // participant.
  cancelDisconnectSweep(conversationID, clientId);

  const room = nativeRooms.get(conversationID);
  if (!room) return;

  // Close + remove all producers owned by this client
  const ownedProducerIds = await rs
    .deleteAllProducerMetaForClient(conversationID, clientId)
    .catch(() => []);

  for (const producerId of ownedProducerIds) {
    const producer = room.producers.get(producerId);
    if (producer) {
      try {
        producer.close();
      } catch (_) {
        /* no-op */
      }
    }
    room.producers.delete(producerId);
  }

  // Close + remove all transports owned by this client
  for (const [transportId, entry] of room.transports.entries()) {
    if (!entry || entry.clientId !== clientId) continue;
    try {
      entry.transport.close();
    } catch (_) {
      /* no-op */
    }
    room.transports.delete(transportId);
  }
}

// ─── joinRoom ─────────────────────────────────────────────────────────────────

async function joinRoom(
  conversationID,
  entityID,
  username,
  members,
  instance,
  clientId,
  muted,
  cameraOff,
) {
  console.log(
    `[WebRTC] joinRoom called: conversationID=${conversationID}, entityID=${entityID}, clientId=${clientId}`,
  );

  // Unconditionally, before anything else: a join under this clientId means it
  // is alive. evictClientSession cancels too, but only on the reconnect path -
  // and a timer that outlives its member (swept by something else, rejoined
  // here) would otherwise fire 20s from now and evict the session we are about
  // to build.
  cancelDisconnectSweep(conversationID, clientId);

  const room = await getOrCreateNativeRoom(conversationID);
  console.log(`[WebRTC] joinRoom: room ready, router=${!!room.router}`);

  // Cancel any pending stale-room cleanup
  if (emptyRoomTimers.has(conversationID)) {
    clearTimeout(emptyRoomTimers.get(conversationID));
    emptyRoomTimers.delete(conversationID);
  }

  // Detect reconnect — clientId already exists from a dropped session
  const isReconnect = await rs
    .hasMember(conversationID, clientId)
    .catch(() => false);
  if (isReconnect) {
    await evictClientSession(conversationID, clientId);
    console.log(
      `[WebRTC] Reconnect for clientId ${clientId} in ${conversationID}`,
    );
  }

  // Read existing members before adding the new one (for notifications)
  const existingMembers = await rs
    .getAllMembers(conversationID)
    .catch(() => ({}));
  const existingUserIds = new Set(
    Object.values(existingMembers)
      .filter((entry) => entry.entityID !== entityID)
      .map((entry) => entry.entityID),
  );

  // Write member + status to Redis — include pod name for cross-pod pipe routing
  await rs.setMember(conversationID, clientId, {
    entityID,
    username,
    pod: POD_NAME,
  });
  console.log(`[WebRTC] joinRoom: member saved to Redis`);
  const joinedStatus = {
    muted: typeof muted === "boolean" ? muted : false,
    cameraOff: typeof cameraOff === "boolean" ? cameraOff : false,
  };
  await rs.setMemberStatus(conversationID, clientId, joinedStatus);

  // Build participant list for the joining user (everyone else currently in room)
  const allStatuses = await rs
    .getAllMemberStatuses(conversationID)
    .catch(() => ({}));
  const participants = Object.entries(existingMembers)
    .filter(([participantClientId]) => participantClientId !== clientId)
    .map(([participantClientId, participantData]) => ({
      clientId: participantClientId,
      username: participantData?.username || participantData?.entityID || "",
      ...(allStatuses[participantClientId] || {
        muted: false,
        cameraOff: false,
      }),
    }));

  // Notify existing users — skip on reconnect to avoid duplicate join events
  if (!isReconnect) {
    await Promise.all(
      Array.from(existingUserIds).map((existingUserId) =>
        publish(`events_${existingUserId}`, "participant-joined", {
          conversationID,
          username,
          entityID,
          clientId,
          ...joinedStatus,
          timestamp: Date.now(),
          instance,
        }),
      ),
    );
  }

  await publish(`events_${entityID}`, "join-room-response", {
    status: true,
    routerRtpCapabilities: room.router.rtpCapabilities,
    instance,
    clientId,
    participants,
  });
  console.log(
    `[WebRTC] joinRoom: join-room-response published to events_${entityID}`,
  );

  // Late-join sync: replay active producers to the newly joined user.
  // If this pod owns the room, producers are local.
  // If another pod owns the room, pipe all producers here first so the
  // client can consume them locally without any cross-pod consumer path.
  const roomPod = await rs.getRoomPod(conversationID).catch(() => POD_NAME);
  const allProducerMeta = await rs
    .getAllProducerMeta(conversationID)
    .catch(() => ({}));

  if (roomPod && roomPod !== POD_NAME) {
    // This pod doesn't own the room — pipe all existing producers from the owner pod
    await pipeManager
      .pipeAllProducersToLocal(conversationID, roomPod)
      .catch((err) =>
        console.error("[WebRTC] pipeAllProducersToLocal error:", err),
      );
  }

  for (const [producerId, meta] of Object.entries(allProducerMeta)) {
    const ownerMember = meta.clientId
      ? await rs.getMember(conversationID, meta.clientId).catch(() => null)
      : null;
    await publish(`events_${entityID}`, "new_producer", {
      conversationID,
      username: ownerMember?.username || username,
      entityID: ownerMember?.entityID || entityID,
      clientId: meta.clientId,
      producerId,
      kind: meta.kind,
      rtpParameters: meta.rtpParameters,
      source: meta.source || null,
      timestamp: Date.now(),
    });
  }
}

// ─── createTransport ──────────────────────────────────────────────────────────

async function createTransport(
  conversationID,
  entityID,
  username,
  instance,
  direction,
  clientId,
) {
  const room = await getOrCreateNativeRoom(conversationID);

  const transport = await room.router.createWebRtcTransport({
    listenIps: [{ ip: "0.0.0.0", announcedIp: process.env.SERVER_PUBLIC_IP }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    enableSrtp: false,
  });

  transport.on("routerclose", () => {
    room.transports.delete(transport.id);
  });

  // See DISCONNECT_GRACE_MS. ICE consent lapsing is the signal that the peer
  // is gone; reaching "connected"/"completed" again is the signal that it was
  // only a blip, and disarms the sweep.
  transport.on("icestatechange", (iceState) => {
    if (iceState === "disconnected") {
      console.log(
        `[WebRTC] ICE disconnected: client=${clientId} room=${conversationID}`,
      );
      scheduleDisconnectSweep(conversationID, entityID, clientId);
    } else if (iceState === "connected" || iceState === "completed") {
      cancelDisconnectSweep(conversationID, clientId);
    }
  });

  // "failed" only, never "closed": closed is what OUR OWN teardown produces
  // when leaveRoom closes this transport, and arming a sweep from it would
  // schedule a pointless pass over a client that has already left.
  transport.on("dtlsstatechange", (dtlsState) => {
    if (dtlsState !== "failed") return;
    console.log(
      `[WebRTC] DTLS failed: client=${clientId} room=${conversationID}`,
    );
    scheduleDisconnectSweep(conversationID, entityID, clientId);
  });

  // Only native transport object stays in-process
  room.transports.set(transport.id, {
    transport,
    clientId,
    entityID,
    direction,
  });

  await publish(`events_${entityID}`, "create-transport-response", {
    response: {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    },
    direction,
    instance,
    clientId,
  });
}

// ─── transportConnect ─────────────────────────────────────────────────────────

async function transportConnect(
  conversationID,
  entityID,
  transportId,
  dtlsParameters,
  clientId,
) {
  const room = nativeRooms.get(conversationID);
  const entry = room?.transports.get(transportId);

  if (!entry || entry.clientId !== clientId) {
    await publish(`events_${entityID}`, "transport-connect-error", {
      conversationID,
      clientId,
    });
    return;
  }

  await entry.transport.connect({ dtlsParameters });

  await publish(`events_${entityID}`, "transport-connect-response", {
    conversationID,
    message: "OK",
    clientId,
  });
}

// ─── produce ─────────────────────────────────────────────────────────────────

async function produce(
  conversationID,
  transportId,
  kind,
  rtpParameters,
  entityID,
  username,
  _members,
  clientId,
  appData,
) {
  const room = nativeRooms.get(conversationID);
  const entry = room?.transports.get(transportId);

  if (!entry || entry.clientId !== clientId) {
    await publish(`events_${entityID}`, "produce-error", {
      conversationID,
      clientId,
    });
    return;
  }

  const source = appData?.source || null;
  const isScreenShare = source === "screen";

  const codecOptions =
    kind === "video"
      ? {
          videoGoogleStartBitrate: isScreenShare ? 1000 : 600,
          videoGoogleMinBitrate: isScreenShare ? 400 : 100,
          videoGoogleMaxBitrate: isScreenShare ? 1500 : 900,
        }
      : {
          opusStereo: false,
          opusDtx: true,
          opusFec: true,
          opusMaxPlaybackRate: 48000,
        };

  const producer = await entry.transport.produce({
    kind,
    rtpParameters,
    codecOptions,
    appData: appData || {},
  });

  await producer.resume();

  // Native producer stays in-process
  room.producers.set(producer.id, producer);

  // Serializable metadata goes to Redis
  await rs
    .setProducerMeta(conversationID, producer.id, {
      clientId,
      kind,
      source,
      rtpParameters,
    })
    .catch((err) => console.error("[roomState] setProducerMeta error:", err));

  console.log(`[WebRTC] Producer created [${kind}] ID: ${producer.id}`);

  // Read all current members once — used for both pipe routing and fan-out
  const allMembers = await rs.getAllMembers(conversationID).catch(() => ({}));
  const recipientUserIds = Array.from(
    new Set(Object.values(allMembers).map((m) => m.entityID)),
  );
  const ownerMember = allMembers[clientId];
  const displayUsername = ownerMember?.username || username;
  const displayUserId = ownerMember?.entityID || entityID;

  // Auto-notify consumer pods that a new producer is available to pipe.
  // This is fire-and-forget — it never blocks the produce flow.
  // Single-pod guard is inside pipeLocalProducerToPod.
  const roomPod = await rs.getRoomPod(conversationID).catch(() => POD_NAME);
  if (roomPod === POD_NAME) {
    const memberPods = new Set();
    for (const member of Object.values(allMembers)) {
      if (member.pod && member.pod !== POD_NAME) {
        memberPods.add(member.pod);
      }
    }
    for (const targetPod of memberPods) {
      pipeManager
        .pipeLocalProducerToPod(conversationID, producer.id, targetPod)
        .catch((err) =>
          console.error(
            `[WebRTC] pipeLocalProducerToPod to ${targetPod} error:`,
            err,
          ),
        );
    }
  }

  await Promise.all(
    recipientUserIds.map((memberUserId) =>
      publish(`events_${memberUserId}`, "new_producer", {
        conversationID,
        username: displayUsername,
        entityID: displayUserId,
        clientId,
        producerId: producer.id,
        kind,
        rtpParameters,
        source,
        timestamp: Date.now(),
      }),
    ),
  );

  await publish(`events_${entityID}`, "produce-response", {
    conversationID,
    id: producer.id,
    clientId,
  });
}

// ─── consume ─────────────────────────────────────────────────────────────────

async function consume(
  conversationID,
  entityID,
  transportId,
  producerId,
  rtpCapabilities,
  clientId,
) {
  console.log(
    `[WebRTC] consume called: producerId=${producerId}, transportId=${transportId}, clientId=${clientId}`,
  );

  const room = nativeRooms.get(conversationID);
  const entry = room?.transports.get(transportId);

  if (!entry || entry.clientId !== clientId) {
    console.log(
      `[WebRTC] consume: transport not found or clientId mismatch. room=${!!room}, entry=${!!entry}, entry.clientId=${entry?.clientId}`,
    );
    await publish(`events_${entityID}`, "consume-transport-error", {
      conversationID,
      clientId,
    });
    return;
  }

  // If this pod can't consume the producer it's because the producer lives on
  // the owner pod and hasn't been piped here yet. Trigger the pipe now and retry.
  if (!room.router.canConsume({ producerId, rtpCapabilities })) {
    const roomPod = await rs.getRoomPod(conversationID).catch(() => null);

    if (roomPod && roomPod !== POD_NAME) {
      console.log(
        `[WebRTC] Producer ${producerId} not local — piping from ${roomPod} before consuming`,
      );
      try {
        await pipeManager.pipeProducerToLocal(
          conversationID,
          producerId,
          roomPod,
        );
      } catch (pipeErr) {
        console.error(
          `[WebRTC] On-demand pipe failed for producer ${producerId}:`,
          pipeErr,
        );
        await publish(`events_${entityID}`, "consume-error", {
          conversationID,
          clientId,
        });
        return;
      }

      // Re-check after pipe is established
      if (!room.router.canConsume({ producerId, rtpCapabilities })) {
        await publish(`events_${entityID}`, "consume-error", {
          conversationID,
          clientId,
        });
        return;
      }
    } else {
      // Producer genuinely doesn't exist or caps mismatch — not a cross-pod issue
      await publish(`events_${entityID}`, "consume-error", {
        conversationID,
        clientId,
      });
      return;
    }
  }

  const consumer = await entry.transport.consume({
    producerId,
    rtpCapabilities,
  });

  if (consumer.type === "simulcast") {
    await consumer.setPreferredLayers({ spatialLayer: 2, temporalLayer: 2 });
  }

  await consumer.resume();

  const producerMeta = await rs
    .getProducerMeta(conversationID, producerId)
    .catch(() => null);

  await publish(`events_${entityID}`, "consume-response", {
    conversationID,
    id: consumer.id,
    producerId,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters,
    source: producerMeta?.source || null,
    clientId,
  });
}

// ─── closeProducer ───────────────────────────────────────────────────────────

async function closeProducer(conversationID, entityID, clientId, producerId) {
  const room = nativeRooms.get(conversationID);
  if (!room) return;

  const meta = await rs
    .getProducerMeta(conversationID, producerId)
    .catch(() => null);
  if (!meta || meta.clientId !== clientId) return;

  const producer = room.producers.get(producerId);
  if (producer) {
    try {
      producer.close();
    } catch (_) {
      /* no-op */
    }
    room.producers.delete(producerId);
  }

  await rs
    .deleteProducerMeta(conversationID, producerId)
    .catch((err) =>
      console.error("[roomState] deleteProducerMeta error:", err),
    );

  const allMembers = await rs.getAllMembers(conversationID).catch(() => ({}));
  const notifiedUsers = new Set();
  for (const member of Object.values(allMembers)) {
    if (notifiedUsers.has(member.entityID)) continue;
    notifiedUsers.add(member.entityID);
    await publish(`events_${member.entityID}`, "producer-closed", {
      conversationID,
      username: member.username || null,
      entityID,
      clientId,
      producerId,
      timestamp: Date.now(),
    });
  }
}

// ─── leaveRoom ───────────────────────────────────────────────────────────────

async function leaveRoom(conversationID, entityID, clientId) {
  // Whatever brought us here, this client is being torn down now - a pending
  // sweep for it has nothing left to do. Also covers the sweep calling us: the
  // timer has already removed itself, and this is a harmless no-op.
  cancelDisconnectSweep(conversationID, clientId);

  // Read the leaving member's data BEFORE deleting — needed for participant-left broadcast
  const leavingMember = await rs
    .getMember(conversationID, clientId)
    .catch(() => null);

  // Remove participant from Redis regardless of local native room state
  await rs
    .deleteMember(conversationID, clientId)
    .catch((err) => console.error("[roomState] deleteMember error:", err));
  await removeParticipant(conversationID, clientId);

  // Producer metadata lives in Redis, so it is cleared - and its ids reported
  // to everyone else - whether or not THIS pod is the one holding the room.
  // The native close below is best-effort on top of that.
  const ownedProducerIds = await rs
    .deleteAllProducerMetaForClient(conversationID, clientId)
    .catch(() => []);

  // Not a precondition for the broadcast, only for the native teardown. It
  // used to guard everything below it, so a leave arriving after this pod had
  // already evicted the room - exactly what a dead-client sweep can be - tore
  // down Redis and then returned without telling anyone, leaving the departed
  // client on every remaining participant's screen.
  const room = nativeRooms.get(conversationID);

  if (room) {
    // Close + remove this client's producers (native)
    for (const producerId of ownedProducerIds) {
      const producer = room.producers.get(producerId);
      if (producer) {
        try {
          producer.close();
        } catch (_) {
          /* no-op */
        }
        room.producers.delete(producerId);
      }
    }

    // Close + remove this client's transports (native only — no Redis for transports)
    for (const [transportId, entry] of room.transports.entries()) {
      if (!entry || entry.clientId !== clientId) continue;
      try {
        entry.transport.close();
      } catch (_) {
        /* no-op */
      }
      room.transports.delete(transportId);
    }
  }

  // Notify remaining members
  const remainingMembers = await rs
    .getAllMembers(conversationID)
    .catch(() => ({}));
  const notifiedUsers = new Set();
  for (const [memberClientId, member] of Object.entries(remainingMembers)) {
    if (memberClientId === clientId || notifiedUsers.has(member.entityID))
      continue;
    notifiedUsers.add(member.entityID);
    await publish(`events_${member.entityID}`, "participant-left", {
      conversationID,
      username: leavingMember?.username || null,
      entityID: leavingMember?.entityID || entityID,
      clientId,
      producerIds: ownedProducerIds,
      timestamp: Date.now(),
    });
  }

  // Still gated on holding the room: scheduleRoomCleanup deletes the room's
  // Redis keys outright, which is only ours to do when the router is ours.
  if (!room) return;

  const memberCount = await rs.getMemberCount(conversationID).catch(() => 0);
  if (memberCount === 0) {
    scheduleRoomCleanup(conversationID);
  }
}

// ─── participantStatus ───────────────────────────────────────────────────────

async function participantStatus(
  conversationID,
  entityID,
  clientId,
  muted,
  cameraOff,
) {
  const isMember = await rs
    .hasMember(conversationID, clientId)
    .catch(() => false);
  if (!isMember) return;

  const prev = await rs.getMemberStatus(conversationID, clientId).catch(() => ({
    muted: false,
    cameraOff: false,
  }));

  const nextStatus = {
    muted: typeof muted === "boolean" ? muted : prev.muted,
    cameraOff: typeof cameraOff === "boolean" ? cameraOff : prev.cameraOff,
  };

  await rs
    .setMemberStatus(conversationID, clientId, nextStatus)
    .catch((err) => console.error("[roomState] setMemberStatus error:", err));

  const allMembers = await rs.getAllMembers(conversationID).catch(() => ({}));
  const recipientUserIds = Array.from(
    new Set(Object.values(allMembers).map((m) => m.entityID)),
  );
  const member = allMembers[clientId];

  await Promise.all(
    recipientUserIds.map((memberUserId) =>
      publish(`events_${memberUserId}`, "participant-status", {
        conversationID,
        username: member?.username || null,
        entityID: member?.entityID || entityID,
        clientId,
        ...nextStatus,
        timestamp: Date.now(),
      }),
    ),
  );
}

// ─── webRTCEvents (Redis pub/sub relay handler) ───────────────────────────────

function webRTCEvents(event, message) {
  switch (event) {
    case "join-room-relay": {
      const {
        conversationID,
        entityID,
        username,
        members,
        instance,
        clientId,
        muted,
        cameraOff,
      } = message;
      joinRoom(
        conversationID,
        entityID,
        username,
        members,
        instance,
        clientId,
        muted,
        cameraOff,
      ).catch((err) => console.error("join-room-relay error:", err));
      break;
    }
    case "create-transport-relay":
      createTransport(
        message.conversationID,
        message.entityID,
        message.username,
        message.instance,
        message.direction,
        message.clientId,
      ).catch((err) => console.error("create-transport-relay error:", err));
      break;
    case "transport-connect-relay": {
      const {
        conversationID,
        entityID,
        transportId,
        dtlsParameters,
        clientId,
      } = message;
      transportConnect(
        conversationID,
        entityID,
        transportId,
        dtlsParameters,
        clientId,
      ).catch((err) => console.error("transport-connect-relay error:", err));
      break;
    }
    case "produce-relay": {
      const {
        conversationID,
        transportId,
        kind,
        rtpParameters,
        entityID,
        username,
        members,
        clientId,
        appData,
      } = message;
      produce(
        conversationID,
        transportId,
        kind,
        rtpParameters,
        entityID,
        username,
        members,
        clientId,
        appData,
      ).catch((err) => console.error("produce-relay error:", err));
      break;
    }
    case "consume-relay": {
      const {
        conversationID,
        entityID,
        transportId,
        producerId,
        rtpCapabilities,
        clientId,
      } = message;
      consume(
        conversationID,
        entityID,
        transportId,
        producerId,
        rtpCapabilities,
        clientId,
      ).catch((err) => console.error("consume-relay error:", err));
      break;
    }
    case "close-producer-relay":
      closeProducer(
        message.conversationID,
        message.entityID,
        message.clientId,
        message.producerId,
      ).catch((err) => console.error("close-producer-relay error:", err));
      break;
    case "leave-room-relay":
      leaveRoom(
        message.conversationID,
        message.entityID,
        message.clientId,
      ).catch((err) => console.error("leave-room-relay error:", err));
      break;
    case "participant-status-relay":
      participantStatus(
        message.conversationID,
        message.entityID,
        message.clientId,
        message.muted,
        message.cameraOff,
      ).catch((err) => console.error("participant-status-relay error:", err));
      break;
    case "reconnect-relay":
      evictClientSession(message.conversationID, message.clientId).catch(
        (err) => console.error("reconnect-relay error:", err),
      );
      break;
    case "pipe-to-router-request":
    case "pipe-to-router-response":
    case "pipe-new-producer-available":
      pipeManager
        .handlePipeEvent(event, message)
        .catch((err) => console.error(`${event} error:`, err));
      break;
    default:
      break;
  }
}

module.exports = {
  workers,
  nativeRooms,
  workersReadyPromise,
  webRTCEvents,
  evictClientSession,
  joinRoom,
  createTransport,
  transportConnect,
  produce,
  consume,
  closeProducer,
  leaveRoom,
  participantStatus,
  CAMERA_ENCODINGS,
  SCREENSHARE_ENCODINGS,
};
