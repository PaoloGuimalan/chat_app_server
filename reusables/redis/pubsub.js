const redis = require("redis");
const {
  REDIS_HOST,
  REDIS_PORT,
  REDIS_PASSWORD,
  REDIS_USERNAME,
} = require("../vars/redis");

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
}

async function listen(channel, response_holder) {
  if (subscriber) {
    // subscriber.on("error", (err) =>
    //   console.error("Redis Subscriber Error", err)
    // );

    await subscriber.subscribe(channel, (message) => {
      const data = JSON.parse(message);
      response_holder.sse(data.event, data.message);
    });
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

async function stop_listen(channel) {
  if (subscriber) {
    await subscriber.unsubscribe(channel);
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

module.exports = {
  connect_redis,
  listen,
  stop_listen,
  publish,
  listen_sub,
  publish_pub,
};
