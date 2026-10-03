/**
 * The bucket's CORS rule for direct browser uploads.
 *
 *   node scripts/storageCors.js           # show the current rules and the change
 *   node scripts/storageCors.js --apply   # write it
 *
 * The bucket is shared with NeonSystems, so this MERGES: every existing rule
 * is kept, and only Chatterloop's own rule (recognised by its ID, or by
 * being an identical rule) is added or replaced.
 *
 * Origins mirror the API's CORS list in index.js; override with
 * STORAGE_CORS_ORIGINS (comma-separated). ETag is exposed for good measure,
 * but nothing depends on it any more: the server finishes multipart uploads
 * from the parts storage lists (storage.listParts).
 */
require("dotenv").config();
const { GetBucketCorsCommand, PutBucketCorsCommand } = require("@aws-sdk/client-s3");
const storage = require("../reusables/media/storageProvider");

const RULE_ID = "chatterloop-direct-uploads";
const ORIGINS = (process.env.STORAGE_CORS_ORIGINS
  ? process.env.STORAGE_CORS_ORIGINS.split(",")
  : [
      "https://chatterloop.app",
      "https://*.chatterloop.app",
      "https://*.neonsystems.net",
      "http://localhost:5173",
    ]
).map((o) => o.trim()).filter(Boolean);

const OUR_RULE = {
  ID: RULE_ID,
  AllowedOrigins: ORIGINS,
  AllowedMethods: ["PUT", "GET", "HEAD"],
  AllowedHeaders: ["*"],
  ExposeHeaders: ["ETag"],
  MaxAgeSeconds: 3600,
};

const sameRule = (a, b) =>
  JSON.stringify([...(a.AllowedOrigins || [])].sort()) ===
    JSON.stringify([...(b.AllowedOrigins || [])].sort()) &&
  JSON.stringify([...(a.AllowedMethods || [])].sort()) ===
    JSON.stringify([...(b.AllowedMethods || [])].sort());

const main = async () => {
  let current = [];
  try {
    const result = await storage.client.send(new GetBucketCorsCommand({ Bucket: storage.bucket }));
    current = result.CORSRules || [];
  } catch (err) {
    if (!/NoSuchCORSConfiguration/i.test(err.name || err.Code || "")) throw err;
  }

  console.log(`Bucket ${storage.bucket} - current rules:`);
  console.log(JSON.stringify(current, null, 2));

  const kept = current.filter((rule) => rule.ID !== RULE_ID && !sameRule(rule, OUR_RULE));
  const next = [...kept, OUR_RULE];
  console.log("\nRules after the change:");
  console.log(JSON.stringify(next, null, 2));

  if (!process.argv.includes("--apply")) {
    console.log("\nDry run - pass --apply to write it.");
    return;
  }
  await storage.client.send(
    new PutBucketCorsCommand({ Bucket: storage.bucket, CORSConfiguration: { CORSRules: next } }),
  );
  console.log("\nApplied.");
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
