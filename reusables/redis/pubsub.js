const redis = require("redis");
const {
  REDIS_HOST,
  REDIS_PORT,
  REDIS_PASSWORD,
  REDIS_USERNAME,
} = require("../vars/redis");
const roomState = require("./roomState");

const POD_NAME = process.env.POD_NAME || process.env.HOSTNAME || "podless";

const redis_creds = {
  username: REDIS_USERNAME,
  password: REDIS_PASSWORD,
  socket: {
    host: REDIS_HOST,
    port: REDIS_PORT,
  },
};

let subscriber;
let publisher;

const activeStreams = new Map(); // channel -> Set<response_holder>

async function connect_redis() {
  const scope_subscriber = redis.createClient(redis_creds);

  scope_subscriber.on("error", (err) =>
    console.error("Redis Subscriber Error", err),
  );
  await scope_subscriber.connect();
  console.log("Redis subscriber connected");

  subscriber = scope_subscriber;

  const scope_publisher = redis.createClient(redis_creds);

  scope_publisher.on("error", (err) =>
    console.error("Redis Publisher Error", err),
  );
  await scope_publisher.connect();
  console.log("Redis publisher connected");

  publisher = scope_publisher;

  // Share the publisher connection with roomState so all Redis operations
  // use the same authenticated client — no extra connections needed
  roomState.init(scope_publisher);
}

async function listen(channel, response_holder) {
  if (subscriber) {
    if (!activeStreams.has(channel)) {
      activeStreams.set(channel, new Set());

      await subscriber.subscribe(channel, (message) => {
        const data = JSON.parse(message);
        for (const res of activeStreams.get(channel) || []) {
          res.sse(data.event, data.message);
        }
      });
    }

    activeStreams.get(channel).add(response_holder);
  }
}

async function publish(channel, event, message) {
  if (publisher) {
    const logDetails = {
      logType: null,
      pod: POD_NAME,
      event: event,
      message: message,
      dateTime: new Date(),
    };

    // publisher.on("error", (err) => console.error("Redis Publisher Error", err));
    await publisher.publish(channel, JSON.stringify(logDetails));
    // await publisher.disconnect();
  }
}

async function stop_listen(channel, response_holder) {
  if (subscriber) {
    const set = activeStreams.get(channel);
    if (!set) return;

    set.delete(response_holder);

    if (set.size === 0) {
      await subscriber.unsubscribe(channel);
      activeStreams.delete(channel);
    }
    console.log(`Unsubscribed from channel: ${channel}`);
  } else {
    console.error("Subscriber client is not connected");
  }
}

async function listen_sub(channel, callback) {
  if (subscriber) {
    const subscribeName = `SUB_${channel}`;
    console.log(`Listening to ${subscribeName}`);
    await subscriber.subscribe(subscribeName, (message) => {
      const data = JSON.parse(message);
      callback(data.event, data.message);
    });
  }
}

async function publish_pub(channel, event, message) {
  if (publisher) {
    const subscribeName = `SUB_${channel}`;
    const logDetails = {
      logType: null,
      pod: POD_NAME,
      event: event,
      message: message,
      dateTime: new Date(),
    };

    // publisher.on("error", (err) => console.error("Redis Publisher Error", err));
    await publisher.publish(subscribeName, JSON.stringify(logDetails));
    // await publisher.disconnect();
  }
}

// Matches roomState.js's ROOM_TTL_SEC. This hash is the presence record the
// channel rows count ("N in this room"), and it used to be written with no
// expiry at all - so anything that skipped removeParticipant left a phantom
// occupant permanently. The dead-client sweep in webRTC.js covers a client
// dying; this covers the case no client-side signal can, a POD dying, where
// nothing runs to clean up after it.
//
// The TTL is a LEAK HORIZON, never a room lifetime. It is short only because
// webRTC.js's room keepalive refreshes it every few minutes for as long as
// this pod still holds the room's router - so a call running for eight hours
// keeps its presence intact, and a pod that dies stops refreshing and lets the
// residue expire within the hour. Setting it on write alone would have expired
// the key under a settled call that simply had nobody join for an hour.
const PARTICIPANTS_TTL_SEC = 60 * 60; // 1 hour since the last keepalive

async function addParticipant(conversationID, participantData) {
  if (publisher) {
    const key = `call:participants:${conversationID}`;
    const { clientID } = participantData;

    await publisher.hSet(key, clientID, JSON.stringify(participantData));
    await publisher.expire(key, PARTICIPANTS_TTL_SEC);
  }
}

/// Pushes the expiry out for a room that is demonstrably still alive. See
/// PARTICIPANTS_TTL_SEC - this is what makes that TTL safe.
async function touchParticipants(conversationID) {
  if (publisher) {
    await publisher.expire(
      `call:participants:${conversationID}`,
      PARTICIPANTS_TTL_SEC,
    );
  }
}

async function getParticipant(conversationID, clientID) {
  if (publisher) {
    const key = `call:participants:${conversationID}`;
    const data = await publisher.hGet(key, clientID);
    return data ? JSON.parse(data) : null;
  }
}

async function getAllParticipants(conversationID) {
  if (publisher) {
    const key = `call:participants:${conversationID}`;
    const allData = await publisher.hGetAll(key);

    if (!allData || Object.keys(allData).length === 0) {
      return [];
    }

    return Object.values(allData).map((val) => JSON.parse(val));
  }

  return [];
}

async function removeParticipant(conversationID, clientID) {
  if (publisher) {
    const key = `call:participants:${conversationID}`;
    await publisher.hDel(key, clientID);
  }
}

async function removeAllParticipants(conversationID) {
  if (publisher) {
    const key = `call:participants:${conversationID}`;
    await publisher.del(key);
    console.log(`Cleared all participants for conversation: ${conversationID}`);
  }
}

async function isUniqueNonce(userId, timestamp, random) {
  if (publisher) {
    const redisKey = `nonce:${userId}:${timestamp}:${random}`;

    const result = await publisher.set(redisKey, "1", {
      NX: true,
      EX: 60,
    });

    return result === "OK";
  }

  console.error("Redis publisher not connected for nonce check");
  return false;
}

async function bumpLock(key) {
  if (publisher) {
    const status = publisher.set(key, "1", {
      NX: true,
      EX: 1800,
    });

    return status;
  }

  return false;
}

module.exports = {
  connect_redis,
  listen,
  stop_listen,
  publish,
  listen_sub,
  publish_pub,
  addParticipant,
  touchParticipants,
  removeParticipant,
  getAllParticipants,
  isUniqueNonce,
  bumpLock,
  activeStreams
};
