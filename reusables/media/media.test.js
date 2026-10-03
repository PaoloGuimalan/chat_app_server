/**
 * The direct-upload rules, without a database or a bucket: everything that
 * touches one is stubbed on the module objects the code reads through.
 *
 * Run with:  node --test reusables/media/*.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const config = require("./config");
const { cleanFileName, kindOf } = require("./fileNames");
const { S3CompatibleStorage } = require("./storageProvider");
const { legacyAttachmentFor } = require("./legacyAttachment");
const uploads = require("./uploads");

const MB = 1024 * 1024;

// ---- config ----

test("stored limits override defaults feature by feature", () => {
  const merged = config.mergeLimits({
    message: { maxMB: 50, types: ["*"] },
    avatar: { maxMB: "lots" }, // broken: falls back to its default only
    stickers: { maxMB: 1, types: ["image/png"] }, // new: kept without a deploy
  });
  assert.equal(merged.message.maxMB, 50);
  assert.equal(merged.avatar.maxMB, config.DEFAULT_LIMITS.avatar.maxMB);
  assert.deepEqual(merged.stickers, { maxMB: 1, types: ["image/png"] });
  assert.equal(merged.voice_note.maxMB, 25);
});

test("a missing or garbage limits value is just the defaults", () => {
  for (const stored of [undefined, null, "x", [1, 2]]) {
    assert.deepEqual(config.mergeLimits(stored), config.mergeLimits({}));
  }
});

test("transfer settings respect storage's 5MB part floor", () => {
  const t = config.mergeTransfer({ partSizeMB: 1, concurrency: 99, multipartThresholdMB: -3 });
  assert.equal(t.partSizeMB, 5);
  assert.equal(t.concurrency, 16);
  assert.equal(t.multipartThresholdMB, config.DEFAULT_TRANSFER.multipartThresholdMB);
});

test("types match exactly, by family, or anything", () => {
  assert.ok(config.typeAllowed("image/png", ["image/*"]));
  assert.ok(config.typeAllowed("video/mp4", ["image/jpeg", "video/mp4"]));
  assert.ok(config.typeAllowed("application/zip", ["*"]));
  assert.ok(!config.typeAllowed("video/mp4", ["image/*"]));
  assert.ok(!config.typeAllowed("imagex/png", ["image/*"]));
});

test("small files go up whole, big ones in parts that add up", () => {
  const transfer = { multipartThresholdMB: 16, partSizeMB: 8, concurrency: 4 };
  assert.equal(config.transferPlan(15 * MB, transfer).mode, "single");
  const plan = config.transferPlan(20 * MB + 5, transfer);
  assert.equal(plan.mode, "multipart");
  assert.deepEqual(plan.parts.map((p) => p.n), [1, 2, 3]);
  assert.equal(plan.parts.reduce((n, p) => n + p.size, 0), 20 * MB + 5);
  assert.equal(plan.parts[2].size, 4 * MB + 5);
});

test("a huge file grows its parts rather than exceed 10,000", () => {
  const plan = config.transferPlan(100_000 * MB, { multipartThresholdMB: 16, partSizeMB: 8 });
  assert.ok(plan.parts.length <= 10_000);
  assert.equal(plan.parts.reduce((n, p) => n + p.size, 0), 100_000 * MB);
});

// ---- names and kinds ----

test("file names stay recognisable but URL-safe", () => {
  assert.equal(cleanFileName("Report Q3.pdf"), "Report Q3.pdf");
  assert.equal(cleanFileName("C:\\Users\\me\\notes #1?.txt"), "notes _1_.txt");
  assert.equal(cleanFileName("../../etc/passwd"), "passwd");
  assert.equal(cleanFileName("résumé  ñ 日本.docx"), "résumé ñ 日本.docx");
  assert.equal(cleanFileName("50%off.png"), "50_off.png");
  assert.equal(cleanFileName("", "image/png"), "file.png");
  assert.equal(cleanFileName("...", null), "file");
  const long = cleanFileName(`${"a".repeat(300)}.mp4`);
  assert.equal(long.length, 100);
  assert.ok(long.endsWith(".mp4"));
});

test("kinds: SVG is a file, never an image", () => {
  assert.equal(kindOf("image/jpeg"), "image");
  assert.equal(kindOf("image/svg+xml"), "file");
  assert.equal(kindOf("video/mp4"), "video");
  assert.equal(kindOf("audio/webm"), "audio");
  assert.equal(kindOf("application/pdf"), "file");
  assert.equal(kindOf(undefined), "file");
});

test("a sniffed type must agree with the declared one", () => {
  assert.ok(uploads.typesAgree("image/png", "image/jpeg"));
  assert.ok(uploads.typesAgree("audio/webm", "video/webm")); // voice note container
  assert.ok(uploads.typesAgree("text/csv", undefined)); // nothing to contradict
  assert.ok(!uploads.typesAgree("image/png", "video/mp4"));
  assert.ok(!uploads.typesAgree("video/mp4", "audio/mpeg"));
});

test("storage keys: real name inside an unguessable folder", () => {
  assert.equal(
    uploads.keyFor({ purpose: "message", context: { conversationID: "c1" }, messageID: "123", name: "a.pdf" }),
    "uploads/messages/c1/123/a.pdf",
  );
  assert.equal(
    uploads.keyFor({ purpose: "voice_note", context: { conversationID: "c1" }, messageID: "9", name: "v.webm" }),
    "uploads/messages/c1/9/v.webm",
  );
  assert.equal(
    uploads.keyFor({ purpose: "avatar", accountID: "7", context: { realmID: "r1" }, folderID: "f", name: "p.jpg" }),
    "uploads/realms/r1/f/p.jpg",
  );
  assert.equal(
    uploads.keyFor({ purpose: "avatar", accountID: "7", context: {}, folderID: "f", name: "p.jpg" }),
    "uploads/entries/7/f/p.jpg",
  );
  assert.equal(
    uploads.keyFor({ purpose: "comment", accountID: "7", context: {}, folderID: "f", name: "c.png" }),
    "uploads/comments/7/f/c.png",
  );
});

test("messageType keeps the shape installed clients render", () => {
  assert.equal(uploads.messageTypeFor({ kind: "image", mime: "image/png" }), "image");
  assert.equal(uploads.messageTypeFor({ kind: "video", mime: "video/mp4" }), "video/mp4");
  assert.equal(uploads.messageTypeFor({ kind: "file", mime: null }), "application/octet-stream");
});

// ---- storage provider ----

const spaces = new S3CompatibleStorage({
  name: "test",
  bucket: "neon-systems-bucket",
  endpoint: "https://sgp1.digitaloceanspaces.com",
  cdnEndpoint: "sgp1.cdn.digitaloceanspaces.com",
  publicBaseUrl: "https://media.neonsystems.net/",
  key: "k",
  secret: "s",
});

test("public links use the media domain, encoded per segment", () => {
  assert.equal(
    spaces.publicUrl("uploads/messages/c/1/Report Q3 #1.pdf"),
    "https://media.neonsystems.net/uploads/messages/c/1/Report%20Q3%20%231.pdf",
  );
});

test("our links are recognised through every host; others are not", () => {
  const key = "uploads/entries/9/x y.jpg";
  for (const url of [
    "https://media.neonsystems.net/uploads/entries/9/x%20y.jpg",
    "https://neon-systems-bucket.sgp1.cdn.digitaloceanspaces.com/uploads/entries/9/x y.jpg",
    "https://neon-systems-bucket.sgp1.digitaloceanspaces.com/uploads/entries/9/x%20y.jpg",
    "https://sgp1.digitaloceanspaces.com/neon-systems-bucket/uploads/entries/9/x%20y.jpg",
  ]) {
    assert.equal(spaces.keyFromUrl(url), key, url);
  }
  for (const url of [
    "https://storage.googleapis.com/x/a.png",
    "https://other.sgp1.cdn.digitaloceanspaces.com/uploads/a.png",
    "https://sgp1.digitaloceanspaces.com/other-bucket/uploads/a.png",
    "not a url",
  ]) {
    assert.equal(spaces.keyFromUrl(url), null, url);
  }
});

test("upload links sign the type, disposition and size, and carry no ACL", async () => {
  const target = await spaces.singleUploadTarget({
    key: "uploads/x/a.pdf",
    contentType: "application/pdf",
    disposition: "attachment",
    size: 10,
  });
  const signed = new URL(target.url).searchParams.get("X-Amz-SignedHeaders").split(";");
  for (const header of ["content-type", "content-disposition", "content-length"]) {
    assert.ok(signed.includes(header), header);
  }
  // Files go up private; the server publishes them once checked.
  assert.equal(new URL(target.url).searchParams.get("x-amz-acl"), null);
  assert.equal(target.headers["Content-Type"], "application/pdf");
});

// ---- legacy attachments (the backfill) ----

const keyOf = (url) => spaces.keyFromUrl(url);

test("a server upload's name loses its 10-digit prefix", () => {
  const found = legacyAttachmentFor(
    {
      content:
        "https://neon-systems-bucket.sgp1.cdn.digitaloceanspaces.com/uploads/messages/c1/4829103746_Report Q3.pdf",
      messageType: "application/pdf",
    },
    keyOf,
  );
  assert.equal(found.attachment.name, "Report Q3.pdf");
  assert.equal(found.attachment.kind, "file");
  assert.equal(found.attachment.status, "available");
  assert.equal(found.key, "uploads/messages/c1/4829103746_Report Q3.pdf");
});

test("a bare 'image' message gets its type from the extension", () => {
  const found = legacyAttachmentFor(
    {
      content:
        "https://neon-systems-bucket.sgp1.cdn.digitaloceanspaces.com/uploads/messages/c1/1234567890_IMG%201.PNG",
      messageType: "image",
    },
    keyOf,
  );
  assert.equal(found.attachment.name, "IMG 1.PNG");
  assert.equal(found.attachment.mime, "image/png");
  assert.equal(found.attachment.kind, "image");
});

test("Firebase-era messages keep their name but are unavailable", () => {
  const found = legacyAttachmentFor(
    {
      content: "https://storage.googleapis.com/b/files/IMG_123.pdf%%%Lecture notes.pdf",
      messageType: "application/pdf",
    },
    keyOf,
  );
  assert.equal(found.attachment.name, "Lecture notes.pdf");
  assert.equal(found.attachment.status, "unavailable");
  assert.equal(found.key, null);
});

test("links that aren't ours get no attachment", () => {
  assert.equal(
    legacyAttachmentFor({ content: "https://youtube.com/watch?v=1", messageType: "video/mp4" }, keyOf),
    null,
  );
  assert.equal(legacyAttachmentFor({ content: "hello", messageType: "image" }, keyOf), null);
});

// ---- release publishing (deciding and deleting is worker_service's) ----

test("a release job carries clean, unique URLs and skips empty items", async () => {
  const workqueue = require("../rabbitmq/workqueue");
  const sent = [];
  const original = workqueue.publish;
  workqueue.publish = async (queue, payload) => sent.push({ queue, payload });
  delete require.cache[require.resolve("./release")];
  const { publishRelease } = require("./release");
  try {
    await publishRelease([
      { target: { type: "message", id: "m1" }, urls: ["https://a/x.pdf%%%x.pdf", "https://a/x.pdf", null] },
      { target: { type: "post", id: "p1" }, urls: [] },
    ]);
    assert.equal(await publishRelease([{ target: { type: "post", id: "p2" }, urls: [""] }]), false);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].queue, "media_release");
    assert.deepEqual(sent[0].payload, {
      items: [{ target: { type: "message", id: "m1" }, urls: ["https://a/x.pdf"] }],
    });
  } finally {
    workqueue.publish = original;
  }
});
