const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");

const clientSecret = "client-request-test-key-not-for-authentication";
const authenticationSecret = "server-only-authentication-test-key-different";
const claims = { userID: "account-1", entity: "entity-1", hash: crypto.createHash("sha256").update("registered-device").digest("hex") };

function loadModule(filename, dependencies) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module,
    exports: module.exports,
    Buffer,
    process: { env: { JWT_SECRET: clientSecret, AUTHENTICATION_SECRET: authenticationSecret } },
    console: { log() {}, error() {} },
    require(name) {
      if (name in dependencies) return dependencies[name];
      if (name === "dotenv") return { config() {} };
      return require(name);
    },
  }, { filename });
  return module.exports;
}

function middleware(sessionExists = true) {
  const decryptor = loadModule(require.resolve("./crypto"), {});
  return loadModule(require.resolve("./jwthelper"), {
    "../../schema/auth/useraccount": {},
    "../../schema/auth/sessions": {
      findOne: async ({ deviceToken, entityID }) =>
        sessionExists && ["registered-device", "other-registered-device"].includes(deviceToken) && entityID === "entity-1"
          ? { fcmToken: null } : null,
    },
    "../database/postgres": {
      query: async (_query, [id]) => ({ rows: id === "account-1" ? [{ id, username: "person" }] : [] }),
    },
    "./crypto": decryptor,
    "../redis/pubsub": { isUniqueNonce: async () => true },
    "../../schema/messages/message": {},
  });
}

function nonce() {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", crypto.createHash("sha256").update(clientSecret).digest(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(`account-1.${Math.floor(Date.now() / 1000)}.unique`, "utf8"),
    cipher.final(), cipher.getAuthTag(),
  ]);
  return `${iv.toString("hex")}.${ciphertext.toString("hex")}`;
}

function authenticate(secret, sessionExists = true, tokenClaims = claims, deviceToken = "registered-device") {
  return new Promise((resolve, reject) => {
    const request = { headers: {
      origin: "https://chatterloop.app",
      "device-token": deviceToken,
      "x-access-token": jwt.sign(tokenClaims, secret),
      "x-nonce": nonce(),
    }, params: {} };
    const response = { statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      send(body) { resolve({ allowed: false, status: this.statusCode, body }); },
    };
    Promise.resolve(middleware(sessionExists).jwtchecker(request, response, () => {
      resolve({ allowed: true, userID: request.params.userID, deviceToken: request.params.deviceToken });
    })).catch(reject);
  });
}

test("server authentication token and client-encrypted nonce retain registered-device access", async () => {
  assert.deepEqual(await authenticate(authenticationSecret), {
    allowed: true, userID: "account-1", deviceToken: "registered-device",
  });
});

test("client signing key cannot authenticate even with a registered device and valid nonce", async () => {
  assert.equal((await authenticate(clientSecret)).allowed, false);
});

test("server authentication token still requires the registered device session", async () => {
  const result = await authenticate(authenticationSecret, false);
  assert.equal(result.allowed, false);
  assert.equal(result.status, 401);
  assert.equal(result.body.message, "Device not recognized. Try logging in again.");
});

function subscribe(innerSecret, deviceToken = "registered-device", tokenClaims = claims) {
  return new Promise((resolve) => {
    const token = jwt.sign({ token: jwt.sign(tokenClaims, innerSecret), type: "notifications", deviceToken }, clientSecret);
    middleware().jwtssechecker({ params: { token }, headers: { origin: "https://chatterloop.app" } }, {
      sse(_type, body) { resolve({ allowed: false, body }); },
      send(_type, body) { resolve({ allowed: false, body }); },
    }, () => resolve({ allowed: true }));
  });
}

test("SSE keeps its client-signed envelope and verifies inner authentication with the server key", async () => {
  assert.equal((await subscribe(authenticationSecret)).allowed, true);
  assert.equal((await subscribe(clientSecret)).allowed, false);
});

test("response envelopes retain the client verification key", () => {
  const helpers = middleware();
  assert.deepEqual(jwt.verify(helpers.createJWT({ hello: "world" }), clientSecret).data, { hello: "world" });
  assert.equal(jwt.verify(helpers.createJWTwExp({ hello: "world" }), clientSecret).hello, "world");
});

test("a copied authentication token cannot use another registered device", async () => {
  const result = await authenticate(authenticationSecret, true, claims, "other-registered-device");
  assert.equal(result.allowed, false);
  assert.equal(result.status, 401);
});

test("authentication rejects legacy and malformed device claims", async () => {
  for (const hash of [undefined, null, "", "0".repeat(64), [], {}, 123]) {
    assert.equal((await authenticate(authenticationSecret, true, { ...claims, hash })).allowed, false);
  }
});

test("SSE rejects a copied token in a newly signed envelope for another device", async () => {
  assert.equal((await subscribe(authenticationSecret, "other-registered-device")).allowed, false);
  assert.equal((await subscribe(authenticationSecret, undefined, { userID: "account-1", entity: "entity-1" })).allowed, false);
});

function callAuthentication(tokenClaims, deviceToken, secret = authenticationSecret) {
  let authenticate;
  const namespace = { use(handler) { authenticate = handler; }, on() {} };
  const sockets = loadModule(require.resolve("../../socketIO/socketIO"), {
    "socket.io": { Server: class { of() { return namespace; } } },
    "../reusables/hooks/sse": {},
    "../reusables/hooks/crypto": loadModule(require.resolve("./crypto"), {}),
  });
  sockets.initSocketIO({});
  return new Promise(resolve => {
    const socket = { handshake: { auth: { token: jwt.sign(tokenClaims, secret), deviceToken } } };
    authenticate(socket, error => resolve({ allowed: !error, userID: socket.userID }));
  });
}

test("call socket binds authentication to the supplied device credential", async () => {
  assert.equal((await callAuthentication(claims, "registered-device")).userID, "account-1");
  assert.equal((await callAuthentication(claims, "other-registered-device")).allowed, false);
  assert.equal((await callAuthentication(claims, undefined)).allowed, false);
  assert.equal((await callAuthentication({ userID: "account-1", entity: "entity-1" }, "registered-device")).allowed, false);
  assert.equal((await callAuthentication(claims, "registered-device", clientSecret)).allowed, false);
});

async function keepalive(tokenClaims, deviceToken) {
  let handler;
  let departures = 0;
  const router = { get() {}, post(path, ...handlers) {
    if (path === "/leave-room-keepalive") handler = handlers.at(-1);
  } };
  loadModule(require.resolve("../../routes/webrtc"), {
    express: { Router: () => router },
    "../../reusables/hooks/jwthelper": { jwtchecker() {} },
    "../../reusables/hooks/crypto": loadModule(require.resolve("./crypto"), {}),
    "../../reusables/hooks/permissionChecker": { requiresPermission: () => () => {} },
    "../../reusables/redis/pubsub": { publish: async () => {}, publish_pub: async () => {} },
    "../../reusables/hooks/webRTC": { leaveRoom: async () => { departures++; } },
    "../../reusables/models/messages": { GetAllReceivers: async () => ({ users: [] }) },
    "../../reusables/models/realms": {},
    "../../reusables/redis/roomState": { getRoomPod: async () => null },
  });
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, send(body) { this.body = body; } };
  await handler({ headers: { "x-access-token": jwt.sign(tokenClaims, authenticationSecret), "device-token": deviceToken }, body: { conversationID: "conversation-1" } }, response);
  return { allowed: response.body.status, status: response.statusCode, departures };
}

test("browser-close cleanup requires the token's matching device before cleanup", async () => {
  assert.deepEqual(await keepalive(claims, "registered-device"), { allowed: true, status: 200, departures: 1 });
  for (const device of [undefined, "other-registered-device"]) {
    assert.deepEqual(await keepalive(claims, device), { allowed: false, status: 401, departures: 0 });
  }
  assert.equal((await keepalive({ userID: "account-1", entity: "entity-1" }, "registered-device")).allowed, false);
});
