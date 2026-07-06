require("dotenv").config();
const express = require("express");
const { jwtchecker } = require("../../reusables/hooks/jwthelper");
const { requiresPermission } = require("../../reusables/hooks/permissionChecker");
const { publish_pub, publish } = require("../../reusables/redis/pubsub");
const {
  createTransport,
  transportConnect,
  produce,
  consume,
  closeProducer,
  joinRoom,
  leaveRoom,
  participantStatus,
  evictClientSession,
  CAMERA_ENCODINGS,
  SCREENSHARE_ENCODINGS,
} = require("../../reusables/hooks/webRTC");
const { GetAllReceivers } = require("../../reusables/models/messages");
const { isRealmMember } = require("../../reusables/models/realms");
const { getRoomPod } = require("../../reusables/redis/roomState");
const router = express.Router();

const POD_NAME = process.env.POD_NAME || process.env.HOSTNAME || "podless";

/**
 * resolveTargetPod
 *
 * Determines where a request should be processed:
 *
 *   1. If the room has a pod recorded in Redis → use that pod.
 *   2. If not (room doesn't exist yet, e.g. first join) → use this pod.
 *
 * The client no longer drives routing. `instance` from the request body is
 * accepted only as an explicit override (used during reconnect flows where
 * the client already knows which pod it was on).
 */
async function resolveTargetPod(conversationID, explicitInstance = null) {
  if (explicitInstance && explicitInstance !== POD_NAME) {
    // Client provided an explicit override — trust it (reconnect path only)
    return explicitInstance;
  }

  const roomPod = await getRoomPod(conversationID).catch(() => null);

  console.log(
    `[resolveTargetPod] room=${conversationID}, roomPod=${roomPod}, POD_NAME=${POD_NAME}`,
  );

  if (!roomPod || roomPod === POD_NAME) {
    // Room is here or doesn't exist yet — handle locally
    return POD_NAME;
  }

  // Room is recorded on another pod — verify that pod is still alive.
  // If the pod's IP registration has expired (pod died/restarted), treat
  // the room as orphaned and handle locally (this pod takes ownership).
  const { getPodIp } = require("../../reusables/redis/roomState");
  const remotePodIp = await getPodIp(roomPod).catch(() => null);
  if (!remotePodIp) {
    console.log(
      `[resolveTargetPod] Stale pod "${roomPod}" (no IP) — handling locally`,
    );
    return POD_NAME;
  }

  // Room is owned by another live pod — relay to it
  return roomPod;
}

/**
 * relayOrRun
 *
 * If targetPod is this pod: run localFn() directly.
 * If targetPod is another pod: publish the event via Redis pub/sub relay.
 */
async function relayOrRun(targetPod, relayEvent, relayPayload, localFn) {
  if (targetPod === POD_NAME) {
    return localFn();
  }
  return publish_pub(targetPod, relayEvent, relayPayload);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

router.get("/encodings", jwtchecker, (_req, res) => {
  res.json({
    status: true,
    camera: CAMERA_ENCODINGS,
    screenshare: SCREENSHARE_ENCODINGS,
  });
});

router.post(
  "/join-room",
  jwtchecker,
  requiresPermission("webrtc.call.join"),
  async (req, res) => {
  const { conversationID, members, muted, cameraOff } = req.body;
  const userId = req.params.userID;
  const id = req.params.id;
  const entity_id = req.params.entity_id;
  const username = req.body.username || req.body.displayName || userId;
  const clientId = req.body.clientId || entity_id;

  try {
    await isRealmMember(conversationID, entity_id);

    const targetPod = await resolveTargetPod(conversationID);

    await relayOrRun(
      targetPod,
      "join-room-relay",
      {
        conversationID,
        entityID: entity_id,
        username,
        members,
        instance: targetPod,
        clientId,
        muted,
        cameraOff,
      },
      () =>
        joinRoom(
          conversationID,
          entity_id,
          username,
          members,
          POD_NAME,
          clientId,
          muted,
          cameraOff,
        ),
    );

    res.send({ status: true, message: "OK" });
  } catch (ex) {
    console.error("join-room error:", ex);
    res
      .status(400)
      .send({ status: false, message: ex.message || ex.toString() });
  }
});

router.post("/create-transport", jwtchecker, async (req, res) => {
  const { conversationID, direction } = req.body;
  const userId = req.params.userID;
  const entityID = req.params.entity_id;
  const id = req.params.id;
  const username = req.body.username || req.body.displayName || null;
  const clientId = req.body.clientId || entityID;

  try {
    await isRealmMember(conversationID, entityID);

    const targetPod = await resolveTargetPod(conversationID);

    await relayOrRun(
      targetPod,
      "create-transport-relay",
      {
        conversationID,
        entityID,
        username,
        instance: targetPod,
        direction,
        clientId,
      },
      () =>
        createTransport(
          conversationID,
          entityID,
          username,
          targetPod,
          direction,
          clientId,
        ),
    );

    res.send({ status: true, message: "OK" });
  } catch (error) {
    console.error("create-transport error:", error);
    res.status(500).json({ error: error.message || error.toString() });
  }
});

router.post("/transport-connect", jwtchecker, async (req, res) => {
  const { conversationID, transportId, dtlsParameters } = req.body;
  const userId = req.params.userID;
  const entityID = req.params.entity_id;
  const id = req.params.id;
  const clientId = req.body.clientId || entityID;

  try {
    await isRealmMember(conversationID, entityID);

    const targetPod = await resolveTargetPod(conversationID);

    await relayOrRun(
      targetPod,
      "transport-connect-relay",
      { conversationID, entityID, transportId, dtlsParameters, clientId },
      () =>
        transportConnect(
          conversationID,
          entityID,
          transportId,
          dtlsParameters,
          clientId,
        ),
    );

    res.send({ status: true, message: "OK" });
  } catch (error) {
    console.error("transport-connect error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/produce", jwtchecker, async (req, res) => {
  const { conversationID, transportId, kind, rtpParameters, members, appData } =
    req.body;
  const userId = req.params.userID;
  const id = req.params.id;
  const entityID = req.params.entity_id;
  const username = req.body.username || req.body.displayName || null;
  const clientId = req.body.clientId || entityID;

  try {
    await isRealmMember(conversationID, entityID);

    const targetPod = await resolveTargetPod(conversationID);

    await relayOrRun(
      targetPod,
      "produce-relay",
      {
        conversationID,
        transportId,
        kind,
        rtpParameters,
        entityID,
        username,
        members,
        clientId,
        appData,
      },
      () =>
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
        ),
    );

    res.send({ status: true, message: "OK" });
  } catch (error) {
    console.error("produce error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/consume", jwtchecker, async (req, res) => {
  const { conversationID, transportId, producerId, rtpCapabilities } = req.body;
  const userId = req.params.userID;
  const id = req.params.id;
  const entityID = req.params.entity_id;
  const clientId = req.body.clientId || entityID;

  console.log(
    `[Route] /consume called: conversationID=${conversationID}, producerId=${producerId}, clientId=${clientId}`,
  );

  try {
    await isRealmMember(conversationID, entityID);

    const targetPod = await resolveTargetPod(conversationID);

    await relayOrRun(
      targetPod,
      "consume-relay",
      {
        conversationID,
        entityID,
        transportId,
        producerId,
        rtpCapabilities,
        clientId,
      },
      () =>
        consume(
          conversationID,
          entityID,
          transportId,
          producerId,
          rtpCapabilities,
          clientId,
        ),
    );

    res.send({ status: true, message: "OK" });
  } catch (error) {
    console.error("consume error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/close-producer", jwtchecker, async (req, res) => {
  const { conversationID, producerId } = req.body;
  const userId = req.params.userID;
  const id = req.params.id;
  const entityID = req.params.entity_id;
  const clientId = req.body.clientId || entityID;

  try {
    await isRealmMember(conversationID, entityID);

    const targetPod = await resolveTargetPod(conversationID);

    await relayOrRun(
      targetPod,
      "close-producer-relay",
      { conversationID, entityID, clientId, producerId },
      () => closeProducer(conversationID, entityID, clientId, producerId),
    );

    res.send({ status: true, message: "OK" });
  } catch (error) {
    console.error("close-producer error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Lightweight leave endpoint for browser close (keepalive fetch).
// Only validates the JWT token — no nonce required since leave is idempotent
// and replaying it has no harmful effect.
router.post("/leave-room-keepalive", async (req, res) => {
  const token = req.headers["x-access-token"];
  if (!token) {
    res.status(401).send({ status: false, message: "No token" });
    return;
  }

  const jwt = require("jsonwebtoken");
  const JWT_SECRET = process.env.JWT_SECRET;

  let entityID;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    entityID = decoded.entityID;
  } catch (err) {
    res.status(401).send({ status: false, message: "Invalid token" });
    return;
  }

  const { conversationID } = req.body;
  const clientId = req.body.clientId || entityID;

  // Respond immediately — cleanup must not block the browser close
  res.send({ status: true, message: "OK" });

  try {
    const savedRecipients = await GetAllReceivers(conversationID).catch(() => ({
      users: [],
    }));
    const parsedSavedRecipients = savedRecipients.users.map((mp) => mp.userID);
    const recipients = req.body.recipients
      ? [...req.body.recipients, ...parsedSavedRecipients, entityID]
      : [...parsedSavedRecipients, entityID];
    const uniqueRecipients = [...new Set(recipients)];

    await Promise.all(
      uniqueRecipients.map((mp) =>
        publish(`events_${mp}`, "update_participants", {
          status: true,
          auth: true,
          result: { clientId, action: "left" },
        }).catch(() => {}),
      ),
    );
  } catch (err) {
    console.error("leave-room-keepalive notification error:", err);
  }

  try {
    const targetPod = await resolveTargetPod(conversationID);
    await relayOrRun(
      targetPod,
      "leave-room-relay",
      { conversationID, entityID, clientId },
      () => leaveRoom(conversationID, entityID, clientId),
    );
  } catch (error) {
    console.error("leave-room-keepalive cleanup error:", error);
  }
});

router.post("/leave-room", jwtchecker, async (req, res) => {
  const { conversationID } = req.body;
  const userId = req.params.userID;
  const entityID = req.params.entity_id;
  const id = req.params.id;
  const clientId = req.body.clientId || entityID;

  // Respond immediately — leave cleanup must not be blocked by auth/DB errors
  // on keepalive requests (browser close). The cleanup runs unconditionally.
  res.send({ status: true, message: "OK" });

  try {
    // Auth check — skip silently on keepalive if it fails, cleanup still runs below
    await isRealmMember(conversationID, entityID).catch(() => {});

    // Notify conversation recipients about the departure
    const savedRecipients = await GetAllReceivers(conversationID).catch(() => ({
      users: [],
    }));
    const parsedSavedRecipients = savedRecipients.users.map(
      (mp) => mp.entityID,
    );
    const recipients = req.body.recipients
      ? [...req.body.recipients, ...parsedSavedRecipients, entityID]
      : [...parsedSavedRecipients, entityID];
    const uniqueRecipients = [...new Set(recipients)];

    await Promise.all(
      uniqueRecipients.map((mp) =>
        publish(`events_${mp}`, "update_participants", {
          status: true,
          auth: true,
          result: { clientId, action: "left" },
        }).catch(() => {}),
      ),
    );
  } catch (err) {
    console.error("leave-room notification error (non-fatal):", err);
  }

  // Always run the actual room cleanup — even if notifications fail
  try {
    const targetPod = await resolveTargetPod(conversationID);
    await relayOrRun(
      targetPod,
      "leave-room-relay",
      { conversationID, entityID, clientId },
      () => leaveRoom(conversationID, entityID, clientId),
    );
  } catch (error) {
    console.error("leave-room cleanup error:", error);
  }
});

router.post("/participant-status", jwtchecker, async (req, res) => {
  const { conversationID, muted, cameraOff } = req.body;
  const userId = req.params.userID;
  const id = req.params.id;
  const entityID = req.params.entity_id;
  const clientId = req.body.clientId || entityID;

  try {
    await isRealmMember(conversationID, entityID);

    const targetPod = await resolveTargetPod(conversationID);

    await relayOrRun(
      targetPod,
      "participant-status-relay",
      { conversationID, entityID, clientId, muted, cameraOff },
      () =>
        participantStatus(conversationID, entityID, clientId, muted, cameraOff),
    );

    res.send({ status: true, message: "OK" });
  } catch (error) {
    console.error("participant-status error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Reconnect: client provides explicit instance override because it knows
// which pod it was previously connected to. resolveTargetPod respects it.
router.post("/reconnect", jwtchecker, async (req, res) => {
  const { conversationID, instance } = req.body;
  const userId = req.params.userID;
  const id = req.params.id;
  const entityID = req.params.entity_id;
  const clientId = req.body.clientId || entityID;

  try {
    await isRealmMember(conversationID, entityID);

    // Use explicit instance override for reconnect — client knows its prior pod
    const targetPod = await resolveTargetPod(conversationID, instance || null);

    await relayOrRun(
      targetPod,
      "reconnect-relay",
      { conversationID, clientId },
      () => evictClientSession(conversationID, clientId),
    );

    res.send({ status: true, message: "OK" });
  } catch (error) {
    console.error("reconnect error:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
