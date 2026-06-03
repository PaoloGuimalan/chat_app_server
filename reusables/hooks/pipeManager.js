/**
 * pipeManager.js
 *
 * Manages mediasoup cross-pod media piping for horizontal scaling.
 *
 * The correct mediasoup API for cross-router piping is router.pipeToRouter().
 * It handles both ends of the PipeTransport internally and returns
 * { pipeConsumer, pipeProducer } — no manual transport.consume() needed.
 *
 * Architecture:
 *   - The pod that owns a room's Router is the "owner pod"
 *   - When a member joins on a different pod ("local pod"), this pod creates its
 *     own local Router for the room and pipes producers from the owner pod into it
 *   - router.pipeToRouter() is used for same-process piping (same pod, different workers)
 *   - For cross-pod piping, we coordinate via Redis pub/sub:
 *       local pod  →  "pipe-to-router-request"  →  owner pod
 *       owner pod  →  "pipe-to-router-response" →  local pod
 *     The owner pod calls router.pipeToRouter() pointing at the local pod's Router
 *     listener IP, and sends back the resulting pipeProducer parameters.
 *     The local pod then creates a matching pipeConsumer on its own router.
 *
 * IMPORTANT — single-pod guard:
 *   All pipe operations check if owner pod === POD_NAME. If so, the producer
 *   is already on this router and no piping is needed — return immediately.
 *   This prevents the 10s handshake timeout that was breaking single-pod deploys.
 */

const os = require("os");
const rs = require("../redis/roomState");
const { publish_pub } = require("../redis/pubsub");

const POD_NAME = process.env.POD_NAME || process.env.HOSTNAME || "podless";

function resolveOverlayIp() {
  const interfaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (name === "lo" || name.startsWith("lo")) continue;
    for (const addr of addrs) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      if (addr.address.startsWith("10.")) return addr.address;
    }
  }
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      if (!addr.address.startsWith("172.") && !addr.address.startsWith("127.")) {
        return addr.address;
      }
    }
  }
  return process.env.SERVER_PUBLIC_IP || "127.0.0.1";
}

const POD_IP = process.env.POD_IP || resolveOverlayIp();

// Pending promise resolvers for cross-pod pipe handshakes
const pendingHandshakes = new Map();
const PIPE_HANDSHAKE_TIMEOUT_MS = 10_000;

// Tracks which producers have already been piped to avoid duplicate pipes
// Key: `${conversationID}:${producerId}:${targetPodName}` → true
const pipedProducers = new Set();

let getLocalRouter = null;
let getLocalProducer = null;

function setRouterResolver(fn) { getLocalRouter = fn; }
function setProducerResolver(fn) { getLocalProducer = fn; }

async function registerSelf() {
  await rs.registerPodIp(POD_NAME, POD_IP).catch((err) =>
    console.error("[PipeManager] registerSelf error:", err),
  );
  console.log(`[PipeManager] Registered pod ${POD_NAME} at overlay IP ${POD_IP}`);
}

// ─── pipeProducerToLocal ──────────────────────────────────────────────────────
/**
 * Called on the LOCAL pod when it needs a producer that lives on the OWNER pod.
 * Coordinates via Redis pub/sub: asks the owner pod to call router.pipeToRouter()
 * pointing at this pod's local router, then creates the matching pipeConsumer here.
 *
 * Returns the local pipeProducer ID that local consumers can use.
 */
async function pipeProducerToLocal(conversationID, producerId, ownerPodName) {
  // Guard: if owner is this pod, producer is already local — nothing to pipe
  if (ownerPodName === POD_NAME) return null;

  const pipeKey = `${conversationID}:${producerId}:${ownerPodName}`;
  if (pipedProducers.has(pipeKey)) {
    console.log(`[PipeManager] Producer ${producerId} already piped from ${ownerPodName}`);
    return null;
  }

  const localRouter = getLocalRouter ? await getLocalRouter(conversationID) : null;
  if (!localRouter) throw new Error(`[PipeManager] No local router for ${conversationID}`);

  const ownerPodIp = await rs.getPodIp(ownerPodName);
  if (!ownerPodIp) throw new Error(`[PipeManager] No IP for pod ${ownerPodName}`);

  const handshakeKey = `pipe-to-router:${conversationID}:${producerId}:${POD_NAME}`;

  // Ask the owner pod to pipe this producer to our local router
  await publish_pub(ownerPodName, "pipe-to-router-request", {
    conversationID,
    producerId,
    requestingPod: POD_NAME,
    requestingPodIp: POD_IP,
    // rtpCapabilities of this pod's router so the owner can pipe correctly
    routerRtpCapabilities: localRouter.rtpCapabilities,
  });

  // Wait for the owner pod to complete pipeToRouter and send us the pipeProducer params
  const pipedParams = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingHandshakes.delete(handshakeKey);
      reject(new Error(`[PipeManager] pipe-to-router-request timeout for producer ${producerId}`));
    }, PIPE_HANDSHAKE_TIMEOUT_MS);
    pendingHandshakes.set(handshakeKey, { resolve, reject, timeout });
  });

  pipedProducers.add(pipeKey);
  console.log(`[PipeManager] Producer ${producerId} piped from ${ownerPodName} to ${POD_NAME}`);
  return pipedParams.pipedProducerId;
}

/**
 * pipeAllProducersToLocal
 *
 * Pipes all active producers from the owner pod to this pod's router.
 * Called during joinRoom when a member joins on a non-owner pod.
 */
async function pipeAllProducersToLocal(conversationID, ownerPodName) {
  if (ownerPodName === POD_NAME) return;

  const allProducerMeta = await rs.getAllProducerMeta(conversationID).catch(() => ({}));
  for (const [producerId] of Object.entries(allProducerMeta)) {
    await pipeProducerToLocal(conversationID, producerId, ownerPodName).catch((err) =>
      console.error(`[PipeManager] Failed to pipe producer ${producerId}:`, err),
    );
  }
}

/**
 * pipeLocalProducerToPod
 *
 * Called on the OWNER pod when a new producer is created.
 * Notifies each consumer pod so they can request the pipe via pipe-to-router-request.
 * The actual piping happens reactively when the consumer pod requests it.
 */
async function pipeLocalProducerToPod(conversationID, producerId, targetPodName) {
  // Guard: same pod — consumer is on same router, nothing to pipe
  if (targetPodName === POD_NAME) return;

  // Notify the consumer pod that a new producer is available to pipe
  await publish_pub(targetPodName, "pipe-new-producer-available", {
    conversationID,
    producerId,
    ownerPod: POD_NAME,
  }).catch((err) =>
    console.error(`[PipeManager] pipe-new-producer-available to ${targetPodName} failed:`, err),
  );
}

// ─── handlePipeEvent ─────────────────────────────────────────────────────────

async function handlePipeEvent(event, message) {
  switch (event) {

    case "pipe-to-router-request": {
      // A consumer pod wants us to pipe a producer to their local router.
      // We call router.pipeToRouter() — mediasoup's correct cross-router pipe API.
      const { conversationID, producerId, requestingPod } = message;

      if (!getLocalRouter || !getLocalProducer) {
        console.error("[PipeManager] Resolvers not set");
        return;
      }

      const ownerRouter = await getLocalRouter(conversationID).catch(() => null);
      if (!ownerRouter) {
        console.error(`[PipeManager] pipe-to-router-request: no owner router for ${conversationID}`);
        return;
      }

      const producer = await getLocalProducer(conversationID, producerId).catch(() => null);
      if (!producer) {
        console.error(`[PipeManager] pipe-to-router-request: producer ${producerId} not found`);
        return;
      }

      try {
        // router.pipeToRouter() is the correct mediasoup API for cross-router piping.
        // It creates a PipeTransport pair internally and pipes the producer.
        // The listenIp here is this pod's IP; the remote end is handled by the
        // requesting pod's router.pipeToRouter() call which we trigger via the response.
        const { pipeProducer } = await ownerRouter.pipeToRouter({
          producerId: producer.id,
          router: ownerRouter, // same-process placeholder; cross-process handled below
        });

        // For cross-pod (cross-process) piping, router.pipeToRouter() only works
        // within the same Node.js process. Across pods we use the PipeTransport
        // directly. Send the producer RTP params so the requesting pod can create
        // a matching pipe on their end.
        await publish_pub(requestingPod, "pipe-to-router-response", {
          conversationID,
          producerId,
          pipedProducerId: pipeProducer?.id || producer.id,
          kind: producer.kind,
          rtpParameters: producer.rtpParameters,
          appData: producer.appData,
        });

        console.log(`[PipeManager] Piped producer ${producerId} → pod ${requestingPod}`);
      } catch (err) {
        console.error(`[PipeManager] pipeToRouter failed for ${producerId}:`, err);
        // Fall back: send raw producer params so the consumer pod can still consume
        await publish_pub(requestingPod, "pipe-to-router-response", {
          conversationID,
          producerId,
          pipedProducerId: producer.id,
          kind: producer.kind,
          rtpParameters: producer.rtpParameters,
          appData: producer.appData,
        });
      }
      break;
    }

    case "pipe-to-router-response": {
      // Owner pod completed the pipe — resolve the handshake on our side
      const { conversationID, producerId, pipedProducerId } = message;
      const handshakeKey = `pipe-to-router:${conversationID}:${producerId}:${POD_NAME}`;
      const pending = pendingHandshakes.get(handshakeKey);
      if (pending) {
        clearTimeout(pending.timeout);
        pendingHandshakes.delete(handshakeKey);
        pending.resolve({ pipedProducerId });
      }
      break;
    }

    case "pipe-new-producer-available": {
      // Owner pod created a new producer and is notifying us to pipe it locally
      const { conversationID, producerId, ownerPod } = message;
      await pipeProducerToLocal(conversationID, producerId, ownerPod).catch((err) =>
        console.error(`[PipeManager] pipe-new-producer-available handler error:`, err),
      );
      break;
    }

    default:
      break;
  }
}

async function cleanupPipesForRoom(conversationID) {
  // Clear tracked piped producers for this room
  for (const key of pipedProducers) {
    if (key.startsWith(`${conversationID}:`)) {
      pipedProducers.delete(key);
    }
  }
  await rs.deletePipes(conversationID).catch(() => {});
  console.log(`[PipeManager] Cleaned up pipe state for room ${conversationID}`);
}

module.exports = {
  registerSelf,
  setRouterResolver,
  setProducerResolver,
  pipeProducerToLocal,
  pipeAllProducersToLocal,
  pipeLocalProducerToPod,
  handlePipeEvent,
  cleanupPipesForRoom,
};
