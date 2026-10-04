/**
 * Every module the server loads must load: a mistake at module scope - an
 * export naming something that no longer exists, a require of a deleted file
 * - throws while the server starts, every container crashes, and Swarm keeps
 * serving the previous release (v1.5.0 did exactly this, over a stale
 * `uploadFolderPrefix` export). `node --check` only parses, so it can't see it.
 *
 * Loaded with every network client swapped for an inert stand-in, so nothing
 * connects anywhere: the .env points at production.
 *
 * Run with:  node --test reusables/modules.load.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");

// Packages that open connections or spawn processes when used.
const NETWORK_PACKAGES = new Set([
  "pg",
  "redis",
  "ioredis",
  "amqplib",
  "amqp-connection-manager",
  "cassandra-driver",
  "express-cassandra",
  "mediasoup",
  "firebase-admin",
  "nodemailer",
  "socket.io",
]);

/**
 * Anything at all: callable, constructible, every property another stand-in.
 * `then` takes callbacks and never calls them, so a module-level
 * `client.connect().then(...)` loads instead of throwing.
 */
const inert = () => {
  const target = function () {};
  return new Proxy(target, {
    get: (_, key) => {
      if (key === Symbol.toPrimitive) return () => "";
      if (key === Symbol.iterator) return function* () {};
      if (key === "then") return () => inert();
      return inert();
    },
    apply: () => inert(),
    construct: () => inert(),
  });
};

const packageName = (request) =>
  request.startsWith("@") ? request.split("/").slice(0, 2).join("/") : request.split("/")[0];

const jsFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(full);
    return entry.name.endsWith(".js") && !entry.name.endsWith(".test.js") ? [full] : [];
  });

test("every route and shared module loads without throwing", () => {
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (NETWORK_PACKAGES.has(packageName(request))) return inert();
    return realLoad.call(this, request, parent, isMain);
  };
  const mongoose = require("mongoose");
  const realConnect = mongoose.connect;
  mongoose.connect = async () => mongoose;

  const failures = [];
  try {
    for (const file of [...jsFiles(path.join(ROOT, "routes")), ...jsFiles(path.join(ROOT, "reusables"))]) {
      try {
        require(file);
      } catch (err) {
        failures.push(`${path.relative(ROOT, file)}: ${err.message}`);
      }
    }
  } finally {
    Module._load = realLoad;
    mongoose.connect = realConnect;
  }
  assert.deepEqual(failures, []);
});
