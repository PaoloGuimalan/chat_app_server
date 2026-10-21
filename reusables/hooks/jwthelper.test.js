const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");

const clientSecret = "client-request-test-key-not-for-authentication";
const authenticationSecret = "server-only-authentication-test-key-different";
const claims = { userID: "account-1", entity: "entity-1" };

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
        sessionExists && deviceToken === "registered-device" && entityID === "entity-1"
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

function authenticate(secret, sessionExists = true) {
  return new Promise((resolve, reject) => {
    const request = { headers: {
      origin: "https://chatterloop.app",
      "device-token": "registered-device",
      "x-access-token": jwt.sign(claims, secret),
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

function subscribe(innerSecret) {
  return new Promise((resolve) => {
    const token = jwt.sign({ token: jwt.sign(claims, innerSecret), type: "notifications", deviceToken: "registered-device" }, clientSecret);
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
