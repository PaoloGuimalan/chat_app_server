require("dotenv").config();
const amqp = require("amqplib");

// Publishing side of the Go worker_service.
//
// Distinct from ./producer.js, which is a FANOUT broadcast for cross-pod SSE and
// is dormant. This is point-to-point work handover: one durable queue per job
// type, published to the default exchange with the queue name as the routing
// key - the same contract worker_service's Publish() uses, and the same one
// user_service's RabbitMQClient speaks.
//
// Best-effort by design. A broker outage must degrade a ranking recalculation,
// never fail the request that triggered it, so nothing here throws.

const {
  RABBITMQ_PROTOCOL,
  RABBITMQ_USER,
  RABBITMQ_PASS,
  RABBITMQ_HOST,
  RABBITMQ_PORT,
  RABBITMQ_VHOST,
} = process.env;

// Credentials are percent-encoded: a password containing @ / : or # would
// otherwise be parsed as part of the host.
const enc = (value) => encodeURIComponent(value || "");

// frameMax is NOT cosmetic tuning. amqplib defaults to 0x1000 (4096) and its
// negotiate() takes Math.min(server, desired), so it answers the broker's
// proposed 131072 with 4096 - which CloudAMQP refuses by closing the socket
// with no connection.close, surfacing as the unhelpful "Socket closed abruptly
// during opening handshake". py-amqp (which user_service uses) defaults to
// 131072 and connects, which is why Django worked and this did not.
//
// Passed on the query string because that is where amqplib reads connection
// tuning from; connect()'s second argument is SOCKET options, not these.
const TUNING = "frameMax=131072&heartbeat=60";

const URL = RABBITMQ_HOST
  ? `${RABBITMQ_PROTOCOL || "amqp"}://${enc(RABBITMQ_USER)}:${enc(
      RABBITMQ_PASS,
    )}@${RABBITMQ_HOST}:${RABBITMQ_PORT}/${enc(RABBITMQ_VHOST)}?${TUNING}`
  : null;

// One per listener registered in worker_service/internal/startup/init.go.
// Referencing a constant makes a typo a crash here rather than a message
// published to a queue nobody consumes.
const QUEUES = {
  UPDATE_RANKING_SCORE: "update_ranking_score",
  SAVE_VIEWCACHE_ENGAGEMENTS: "save_viewcache_engagements",
  BUMP_INTEREST_AFFINITY: "bump_interest_affinity",
  INTERACTION_SCORE_BUMP: "interaction_score_bump",
  // Node-only: user_service has no chat, so its Queues class does not list this.
  BUMP_CHAT_SCORE: "bump_chat_score",
  FOLLOWER_INTERACTION_SCORE_BUMP: "follower_interaction_score_bump",
  CREATE_POST_SCORE_FOR_NEW_POST: "create_post_score_for_new_post",
  BULK_FANOUT_TO_CACHE: "bulk_fanout_to_cache",
  BACKFILL_NEW_FRIEND_FEED: "backfill_new_friend_feed",
  REMOVE_FEED_ON_UNFRIEND: "remove_feed_on_unfriend",
  // Generic: every push type shares this one queue, present and future.
  SEND_PUSH: "send_push",
  // Consumed by chatterloop_services/moderation_service, not the Go worker.
  // ONE ingress queue for all content: the backend hands over the whole unit
  // and the moderation pipeline decides internally which stages it needs. The
  // per-media queues (image_captioning, video_conversion, ...) are that
  // service's internal business, and publishing straight to them would make
  // every future pipeline change a change to this file too.
  CONTENT_TAGGING: "content_tagging",
};

let channelPromise = null;
// Queues already asserted on the current channel. Asserting is idempotent but
// costs a round trip, and these queues are durable - so once per connection is
// enough. Cleared whenever the connection is rebuilt.
let asserted = new Set();

function reset() {
  channelPromise = null;
  asserted = new Set();
}

async function getChannel() {
  if (!URL) return null;

  if (!channelPromise) {
    channelPromise = (async () => {
      const connection = await amqp.connect(URL);

      // Both are required: 'close' fires on a graceful broker shutdown and
      // 'error' on a socket drop, and without a handler the latter is an
      // unhandled 'error' event, which takes the process down.
      connection.on("error", reset);
      connection.on("close", reset);

      const channel = await connection.createChannel();
      channel.on("error", reset);
      channel.on("close", reset);

      return channel;
    })().catch((err) => {
      reset();
      throw err;
    });
  }

  return channelPromise;
}

/**
 * Hand one job to the worker. Resolves true when the broker accepted it.
 *
 * Never rejects - callers are request handlers that have usually already
 * responded, and a failed publish is not a reason to surface an error.
 */
async function publish(queue, payload) {
  if (!URL) {
    console.log(`[workqueue] dropping ${queue}: RABBITMQ_HOST not configured`);
    return false;
  }

  try {
    const channel = await getChannel();
    if (!channel) return false;

    if (!asserted.has(queue)) {
      await channel.assertQueue(queue, { durable: true });
      asserted.add(queue);
    }

    // sendToQueue publishes to the default exchange with the queue name as the
    // routing key, which is what the worker consumes.
    return channel.sendToQueue(queue, Buffer.from(JSON.stringify(payload)), {
      // Survives a broker restart, matching the publisher on the Go side.
      persistent: true,
      contentType: "application/json",
    });
  } catch (err) {
    console.log(`[workqueue] failed to publish to ${queue}:`, err.message || err);
    reset();
    return false;
  }
}

module.exports = { publish, QUEUES };
