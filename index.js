const express = require("express");
const app = express();
const PORT = process.env.PORT || 3001;
const POD_NAME = process.env.POD_NAME || process.env.HOSTNAME || "podless";
const mysql = require("mysql");
const mongoose = require("mongoose");
const bodyParser = require("body-parser");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const path = require("path");
const nodemailer = require("nodemailer");
const socketIO = require("socket.io");

const MongooseConnection = require("./connections/index");

const Auth = require("./routes/auth/index");
const Messages = require("./routes/messages/index");
const Users = require("./routes/users/index");
const Profile = require("./routes/profile/index");
const Posts = require("./routes/posts/index");
const Server = require("./routes/serverrts/index");
const Promptings = require("./routes/promptings/index");
const WebRTC = require("./routes/webrtc/index");
const Realms = require("./routes/realms/index");

const Storage = require("./reusables/hooks/storage");

const { initSocketIO } = require("./socketIO/socketIO");
const { consumeMessages } = require("./reusables/rabbitmq/consumer");
const { connect_redis, listen_sub } = require("./reusables/redis/pubsub");
const { getPool } = require("./reusables/database/postgres");
const rateLimit = require("express-rate-limit");
const { webRTCEvents, workersReadyPromise } = require("./reusables/hooks/webRTC");
const { connect } = require("./reusables/database/cassandra");
const { registerSelf } = require("./reusables/hooks/pipeManager");

const connectMongo = async () => {
  return mongoose.connect(MongooseConnection.url, MongooseConnection.params);
};

app.use(
  bodyParser.urlencoded({
    limit: "200mb",
    extended: false,
  }),
);
app.use(
  bodyParser.json({
    limit: "200mb",
  }),
);
app.use(express.json());
// app.use(
//   cors({
//     origin: "*",
//     credentials: true,
//     optionsSuccessStatus: 200,
//   })
// );

app.set("trust proxy", 1);

const callPaths = ["/webrtc", "/u/call", "/u/rejectcall", "/u/endcall"];

const callLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 3000, // Higher cap for bursty call signaling traffic
  message: "Too many call requests from this IP, please try again later.",
});

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10000, // Limit each IP to 2000 requests per window
  message: "Too many requests from this IP, please try again later.",
  skip: (req) =>
    callPaths.some(
      (prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`),
    ),
});

app.use(callPaths, callLimiter);
app.use(limiter);

const allowedOrigins = [
  /^https:\/\/([a-zA-Z0-9-]+\.)*chatterloop\.app$/,
  /^https:\/\/([a-zA-Z0-9-]+\.)*neonsystems\.net$/,
  /^http:\/\/localhost:5173$/,
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps or Postman)
      if (!origin) return callback(null, true);

      const isAllowed = allowedOrigins.some((regex) => regex.test(origin));

      if (isAllowed) {
        callback(null, true);
      } else {
        // This blocks malicious sites like google.com or attacker.com
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    optionsSuccessStatus: 200,
  }),
);

app.use("/auth", Auth);
app.use("/m", Messages);
app.use("/u", Users);
app.use("/p", Profile);
app.use("/s", Server);
app.use("/posts", Posts);
app.use("/prompt", Promptings);
app.use("/webrtc", WebRTC);
app.use("/realms", Realms);

app.get("/", (req, res) => {
  res.send("Welcome to Chatterloop V2 API!");
});

// Start server only after all critical dependencies are ready
(async () => {
  // 1. Wait for mediasoup workers
  await workersReadyPromise;
  console.log(`[Server] MediaSoup workers ready`);

  // 2. Connect Redis (required for pub/sub SSE delivery)
  await connect_redis();
  listen_sub(POD_NAME, webRTCEvents);
  registerSelf();

  // 3. Connect databases
  getPool();
  connect();
  connectMongo()
    .then(() => console.log(`Connected to MongoDB`))
    .catch((err) => console.log(err));

  // 4. Start accepting HTTP requests only now
  const server = app.listen(PORT, () => {
    console.log(`Server Running: ${PORT} | ${POD_NAME}`);
  });

  initSocketIO(server);
})();
