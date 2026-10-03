/**
 * The upload service end to end - ask, complete, attach - with the bucket and
 * the databases stubbed on the module objects it reads through.
 *
 * Run with:  node --test reusables/media/*.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const pg = require("../database/postgres");
const UploadedFiles = require("../../schema/posts/uploadedfiles");
const UserMessage = require("../../schema/messages/message");
const Conversations = require("../../schema/messages/conversation");
const storage = require("./storageProvider");
const { resetMediaConfigCache } = require("./config");
const uploads = require("./uploads");

const MB = 1024 * 1024;
const PNG = Buffer.from("89504E470D0A1A0A0000000D49484452", "hex");
const MP4 = Buffer.from("000000186674797069736F6D0000020069736F6D69736F32", "hex");

/** A tiny in-memory `files` collection plus a fake bucket. */
const world = () => {
  const records = [];
  const bucket = new Map(); // key -> { size, bytes }
  const removed = [];
  let realmMember = true;

  const wrap = (doc) =>
    Object.assign(doc, {
      save: async function () {
        return this;
      },
    });
  const matches = (doc, q) =>
    Object.entries(q).every(([k, v]) => {
      const value = k.split(".").reduce((o, p) => o?.[p], doc);
      if (v && typeof v === "object" && "$in" in v) return v.$in.includes(value);
      return value === v;
    });

  UploadedFiles.create = async (doc) => {
    const record = wrap({ _id: `id${records.length}`, ...doc });
    records.push(record);
    return record;
  };
  UploadedFiles.exists = async () => null;
  UploadedFiles.findOne = async (q) => records.find((r) => matches(r, q)) || null;
  UploadedFiles.find = async (q) => records.filter((r) => matches(r, q));
  UploadedFiles.updateMany = async () => ({});
  UserMessage.exists = async () => null;
  Conversations.findOne = async () => null;

  // No core_variable table: the defaults apply.
  pg.query = async (sql) => {
    if (sql.includes("core_variable")) throw new Error("no table");
    if (sql.includes("FROM community_realm WHERE realm_id")) {
      return { rows: [{ type: "group", entity_id: "page-entity", is_private: true }] };
    }
    if (sql.includes("FROM community_member")) return { rows: realmMember ? [{ member_id: 1 }] : [] };
    return { rows: [] };
  };
  resetMediaConfigCache();

  storage.singleUploadTarget = async ({ key, contentType, size }) => ({
    method: "PUT",
    url: `https://origin/${key}?signed`,
    headers: { "Content-Type": contentType },
    signedSize: size,
  });
  storage.startMultipart = async () => "UPLOAD-1";
  storage.partTargets = async ({ parts }) =>
    parts.map((p) => ({ ...p, method: "PUT", url: `https://origin/part${p.n}`, headers: {} }));
  storage.completeMultipart = async () => {};
  storage.abortMultipart = async () => {};
  storage.head = async (key) => (bucket.has(key) ? { size: bucket.get(key).size } : null);
  storage.readStart = async (key, n) => bucket.get(key).bytes.subarray(0, n);
  storage.remove = async (key) => {
    removed.push(key);
    bucket.delete(key);
  };

  return {
    records,
    removed,
    /** Puts bytes where a client would have uploaded them. */
    arrive: (key, bytes, size = bytes.length) => bucket.set(key, { bytes, size }),
    notMember: () => {
      realmMember = false;
    },
  };
};

const ask = (overrides) =>
  uploads.createUploads({
    accountID: "acc1",
    entityID: "ent1",
    purpose: "post_media",
    files: [{ name: "photo.png", size: PNG.length, type: "image/png" }],
    ...overrides,
  });

test("a post photo: one signed PUT, a pending record, the media-domain link", async () => {
  const w = world();
  const [upload] = await ask();
  assert.equal(upload.mode, "single");
  assert.equal(upload.method, "PUT");
  assert.equal(upload.name, "photo.png");
  assert.match(upload.fileUrl, /\/uploads\/entries\/acc1\/[0-9a-f-]{36}\/photo\.png$/);
  assert.match(upload.url, /\?signed$/); // where the bytes go
  const record = w.records[0];
  assert.equal(record.status, "pending");
  assert.equal(record.ownerAccount, "acc1");
  assert.equal(record.version, 2);
  assert.equal(record.fileDetails.data, upload.fileUrl);
});

test("a big chat video goes up in parts, in a folder named by its message id", async () => {
  const w = world();
  const [upload] = await ask({
    purpose: "message",
    context: { conversationID: "conv1" },
    files: [{ name: "clip.mp4", size: 20 * MB, type: "video/mp4" }],
  });
  assert.equal(upload.mode, "multipart");
  assert.deepEqual(upload.parts.map((p) => p.n), [1, 2, 3]);
  assert.match(upload.messageID, /^\d{30}$/);
  assert.equal(w.records[0].key, `uploads/messages/conv1/${upload.messageID}/clip.mp4`);
  assert.equal(w.records[0].multipart.partCount, 3);
});

test("the ask refuses what the limits or permissions don't allow", async () => {
  world();
  const refuse = async (overrides, status) => {
    await assert.rejects(ask(overrides), (err) => err.status === status);
  };
  await refuse({ files: [{ name: "a.png", size: 11 * MB, type: "image/png" }], purpose: "avatar" }, 413);
  await refuse({ files: [{ name: "a.pdf", size: 10, type: "application/pdf" }] }, 415);
  await refuse({ purpose: "stickers" }, 400);
  await refuse({ files: Array(11).fill({ name: "a.png", size: 1, type: "image/png" }) }, 400);
  await refuse({ purpose: "message", context: { conversationID: "../etc" } }, 400);
  await refuse(
    { purpose: "voice_note", context: {}, files: [{ name: "v.webm", size: 10, type: "audio/webm" }] },
    400,
  );
});

test("only members of a conversation may upload into it", async () => {
  const w = world();
  w.notMember();
  await assert.rejects(
    ask({
      purpose: "message",
      context: { conversationID: "conv1" },
      files: [{ name: "a.pdf", size: 10, type: "application/pdf" }],
    }),
    (err) => err.status === 403,
  );
});

test("completing checks the stored bytes, then marks it ready", async () => {
  const w = world();
  const [upload] = await ask();
  w.arrive(w.records[0].key, PNG);
  const [result] = await uploads.completeUploads({
    accountID: "acc1",
    uploads: [{ uploadID: upload.uploadID }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.kind, "image");
  assert.equal(result.mime, "image/png");
  assert.equal(w.records[0].status, "ready");
});

test("a file that isn't what it claimed is deleted, not accepted", async () => {
  const w = world();
  const [upload] = await ask();
  w.arrive(w.records[0].key, Buffer.concat([MP4, Buffer.alloc(PNG.length)]).subarray(0, PNG.length));
  const [result] = await uploads.completeUploads({
    accountID: "acc1",
    uploads: [{ uploadID: upload.uploadID }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 415);
  assert.deepEqual(w.removed, [w.records[0].key]);
  assert.equal(w.records[0].status, "deleted");
});

test("a file of the wrong size is deleted", async () => {
  const w = world();
  const [upload] = await ask();
  w.arrive(w.records[0].key, PNG, PNG.length + 1);
  const [result] = await uploads.completeUploads({
    accountID: "acc1",
    uploads: [{ uploadID: upload.uploadID }],
  });
  assert.equal(result.ok, false);
  assert.equal(w.records[0].status, "deleted");
});

test("nothing arrived yet: not finished, nothing deleted", async () => {
  const w = world();
  const [upload] = await ask();
  const [result] = await uploads.completeUploads({
    accountID: "acc1",
    uploads: [{ uploadID: upload.uploadID }],
  });
  assert.equal(result.status, 409);
  assert.equal(w.records[0].status, "pending");
});

test("a multipart upload needs every part's ETag", async () => {
  const w = world();
  const [upload] = await ask({
    files: [{ name: "big.mp4", size: 20 * MB, type: "video/mp4" }],
  });
  const [result] = await uploads.completeUploads({
    accountID: "acc1",
    uploads: [{ uploadID: upload.uploadID, parts: [{ n: 1, etag: "a" }] }],
  });
  assert.equal(result.ok, false);
  w.arrive(w.records[0].key, MP4, 20 * MB);
  const [done] = await uploads.completeUploads({
    accountID: "acc1",
    uploads: [
      {
        uploadID: upload.uploadID,
        parts: [1, 2, 3].map((n) => ({ n, etag: `e${n}` })),
      },
    ],
  });
  assert.equal(done.ok, true);
  assert.equal(done.kind, "video");
});

test("someone else's upload can't be completed or used", async () => {
  const w = world();
  const [upload] = await ask();
  const [result] = await uploads.completeUploads({
    accountID: "intruder",
    uploads: [{ uploadID: upload.uploadID }],
  });
  assert.equal(result.status, 404);
  w.records[0].status = "ready";
  await assert.rejects(
    uploads.resolveAttachable({ urls: [upload.fileUrl], accountID: "intruder" }),
    (err) => err.status === 403,
  );
});

test("attaching: own ready files only; older links still pass for now", async () => {
  const w = world();
  const [upload] = await ask();
  await assert.rejects(
    uploads.resolveAttachable({ urls: [upload.fileUrl], accountID: "acc1" }),
    /isn't ready/,
  );
  w.records[0].status = "ready";
  await assert.rejects(
    uploads.resolveAttachable({ urls: [upload.fileUrl], accountID: "acc1", purposes: ["comment"] }),
    /something else/,
  );
  const found = await uploads.resolveAttachable({
    urls: [upload.fileUrl, "https://old.cdn/legacy.jpg"],
    accountID: "acc1",
    purposes: ["post_media"],
  });
  assert.equal(found.length, 1);
});

test("a message upload only becomes a message in its own conversation", async () => {
  const w = world();
  const [upload] = await ask({
    purpose: "message",
    context: { conversationID: "conv1" },
    files: [{ name: "a.pdf", size: 10, type: "application/pdf" }],
  });
  w.records[0].status = "ready";
  await assert.rejects(
    uploads.resolveMessageUploads({ accountID: "acc1", conversationID: "conv2", uploadIDs: [upload.uploadID] }),
    /another conversation/,
  );
  const [record] = await uploads.resolveMessageUploads({
    accountID: "acc1",
    conversationID: "conv1",
    uploadIDs: [upload.uploadID],
  });
  assert.equal(record.reservedMessageID, upload.messageID);
  assert.deepEqual(
    Object.keys(uploads.attachmentFor(record)).sort(),
    ["fileId", "kind", "mime", "name", "size", "status", "url"],
  );
});

test("cancelling drops an unused upload but never one in use", async () => {
  const w = world();
  const [upload] = await ask();
  await uploads.cancelUpload({ accountID: "acc1", uploadID: upload.uploadID });
  assert.equal(w.records[0].status, "deleted");
  const [second] = await ask();
  w.records[1].status = "attached";
  await assert.rejects(
    uploads.cancelUpload({ accountID: "acc1", uploadID: second.uploadID }),
    (err) => err.status === 409,
  );
});
