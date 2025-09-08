const redis = require("redis");
const {
  REDIS_HOST,
  REDIS_PORT,
  REDIS_PASSWORD,
  REDIS_USERNAME,
} = require("../vars/redis");

const POD_NAME = process.env.POD_NAME || "podless";

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

  await scope_subscriber.connect();
  console.log("Redis subscriber connected");

  subscriber = scope_subscriber;

  const scope_publisher = redis.createClient(redis_creds);

  await scope_publisher.connect();
  console.log("Redis publisher connected");

  publisher = scope_publisher;
}

async function listen(channel, response_holder) {
  if (subscriber) {
    subscriber.on("error", (err) =>
      console.error("Redis Subscriber Error", err)
    );

    await subscriber.subscribe(channel, (message) => {
      console.log(`Received message from ${channel}: ${message}`);
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

    publisher.on("error", (err) => console.error("Redis Publisher Error", err));
    await publisher.publish(channel, JSON.stringify(logDetails));
    // await publisher.disconnect();
  }
}

module.exports = {
  connect_redis,
  listen,
  publish,
};
