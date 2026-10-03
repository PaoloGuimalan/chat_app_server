/**
 * Proves the direct-upload flow against the REAL bucket before any client
 * depends on it. Everything it creates goes under uploads/_spike/ and is
 * deleted at the end.
 *
 *   node scripts/storageSpike.js
 *
 * Checks:
 *   1. a presigned single PUT lands, with the signed type and disposition
 *   2. the file is served through STORAGE_PUBLIC_BASE_URL (the media domain)
 *   3. a body of the wrong size is refused by storage itself
 *   4. a 2-part multipart upload completes from presigned part links, joined
 *      from the parts storage lists (as the server does)
 *   5. the CORS preflight for a browser upload is allowed
 */
require("dotenv").config();
const { randomUUID } = require("crypto");
const storage = require("../reusables/media/storageProvider");
const { dispositionFor } = require("../reusables/hooks/contentType");

const ORIGIN = process.env.SPIKE_ORIGIN || "https://chatterloop.app";
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  - ${detail}` : ""}`);
};

const main = async () => {
  const folder = `uploads/_spike/${randomUUID()}`;
  const singleKey = `${folder}/Spike test #1.txt`;
  const multiKey = `${folder}/spike-multipart.bin`;
  const created = [];

  try {
    // 1. single PUT
    const body = Buffer.from("chatterloop direct upload spike\n");
    const contentType = "text/plain";
    const target = await storage.singleUploadTarget({
      key: singleKey,
      contentType,
      disposition: dispositionFor(contentType, "Spike test #1.txt"),
      size: body.length,
    });
    const put = await fetch(target.url, { method: target.method, headers: target.headers, body });
    created.push(singleKey);
    // Uploads land private; the server publishes them once checked.
    const before = await fetch(storage.publicUrl(singleKey));
    check("an uploaded file is private until published", before.status === 403, `status ${before.status}`);
    await storage.makePublic(singleKey);
    const head = await storage.head(singleKey);
    check(
      "single PUT stored with the signed type",
      put.ok && head?.size === body.length && head?.contentType === contentType,
      `status ${put.status}, size ${head?.size}, type ${head?.contentType}`,
    );

    // 2. served through the media domain
    const publicUrl = storage.publicUrl(singleKey);
    const get = await fetch(publicUrl);
    check(
      "served through the media domain",
      get.ok && (await get.text()) === body.toString(),
      `${publicUrl} -> ${get.status}, disposition ${get.headers.get("content-disposition")}`,
    );

    // 3. wrong size refused
    const sized = await storage.singleUploadTarget({
      key: `${folder}/wrong-size.txt`,
      contentType,
      disposition: "inline",
      size: 10,
    });
    const wrong = await fetch(sized.url, {
      method: "PUT",
      headers: sized.headers,
      body: Buffer.alloc(20),
    });
    if (wrong.ok) created.push(`${folder}/wrong-size.txt`);
    check("a body of the wrong size is refused", !wrong.ok, `status ${wrong.status}`);

    // 4. multipart
    const partSize = 5 * 1024 * 1024;
    const parts = [
      { n: 1, size: partSize },
      { n: 2, size: 1024 },
    ];
    const uploadId = await storage.startMultipart({
      key: multiKey,
      contentType: "application/octet-stream",
      disposition: dispositionFor("application/octet-stream", "spike-multipart.bin"),
    });
    const targets = await storage.partTargets({ key: multiKey, uploadId, parts });
    for (const part of targets) {
      await fetch(part.url, { method: "PUT", body: Buffer.alloc(part.size, part.n) });
    }
    const listed = await storage.listParts({ key: multiKey, uploadId });
    await storage.completeMultipart({ key: multiKey, uploadId, parts: listed });
    created.push(multiKey);
    const multiHead = await storage.head(multiKey);
    check(
      "multipart upload completes from part links",
      listed.length === 2 && multiHead?.size === partSize + 1024,
      `parts listed ${listed.map((p) => `${p.n}:${p.size}`).join(", ")}, size ${multiHead?.size}`,
    );

    // 5. CORS preflight
    const preflight = await fetch(target.url, {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type,content-disposition",
      },
    });
    const allowOrigin = preflight.headers.get("access-control-allow-origin");
    const expose = preflight.headers.get("access-control-expose-headers") || "";
    check(
      "CORS preflight allows a browser upload",
      preflight.ok && (allowOrigin === ORIGIN || allowOrigin === "*"),
      `status ${preflight.status}, allow-origin ${allowOrigin}, expose ${expose || "(none on preflight)"}`,
    );
  } finally {
    for (const key of created) {
      await storage.remove(key).catch((err) => console.log(`cleanup failed for ${key}:`, err.message));
    }
    console.log(`\ncleaned up ${created.length} spike file(s)`);
  }

  process.exit(results.every(Boolean) ? 0 : 1);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
