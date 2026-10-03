/**
 * Gives every older file message its `attachment` (name, type, size), so
 * clients stop reading names out of URLs. One-time; safe to re-run - it only
 * touches messages that have no attachment yet.
 *
 *   node scripts/backfillMessageAttachments.js           # dry run: counts + samples
 *   node scripts/backfillMessageAttachments.js --apply   # write them
 *   options: --limit N   stop after N messages
 *            --verbose   print every message, not a sample
 *
 * Runs against the database in .env - PRODUCTION. Run the dry run first.
 * Sizes come from a metadata request per file (no download). A file missing
 * from storage is recorded as unavailable.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const MongooseConnection = require("../connections/index");
const UserMessage = require("../schema/messages/message");
const storage = require("../reusables/media/storageProvider");
const { legacyAttachmentFor } = require("../reusables/media/legacyAttachment");

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] : undefined;
};
const APPLY = has("apply");
const VERBOSE = has("verbose");
const LIMIT = Number(value("limit")) || Infinity;
const CONCURRENCY = 8;
const BATCH = 200;

const main = async () => {
  await mongoose.connect(MongooseConnection.url);
  console.log(APPLY ? "APPLYING" : "DRY RUN (pass --apply to write)");

  const cursor = UserMessage.find({
    attachment: { $exists: false },
    isDeleted: { $ne: true },
    messageType: { $nin: ["text", "notif", "post"] },
    content: { $type: "string", $ne: "" },
  })
    .select({ messageID: 1, content: 1, messageType: 1 })
    .lean()
    .cursor();

  const counts = { seen: 0, written: 0, skipped: 0, unavailable: 0, missingInStorage: 0 };
  let pending = [];
  let samples = 0;

  const flush = async () => {
    const batch = pending;
    pending = [];
    // Sizes, a few requests at a time.
    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      await Promise.all(
        batch.slice(i, i + CONCURRENCY).map(async (item) => {
          if (!item.key) return;
          try {
            const head = await storage.head(item.key);
            if (head) {
              item.attachment.size = head.size;
            } else {
              item.attachment.status = "unavailable";
              counts.missingInStorage += 1;
            }
          } catch (err) {
            console.log(`  size lookup failed for ${item.messageID}: ${err.message || err}`);
          }
        }),
      );
    }
    for (const item of batch) {
      if (item.attachment.status === "unavailable") counts.unavailable += 1;
      if (VERBOSE || samples < 15) {
        samples += 1;
        console.log(`  ${item.messageID}  ${JSON.stringify(item.attachment)}`);
      }
    }
    if (APPLY && batch.length) {
      await UserMessage.bulkWrite(
        batch.map((item) => ({
          updateOne: {
            filter: { messageID: item.messageID, attachment: { $exists: false } },
            update: { $set: { attachment: item.attachment } },
          },
        })),
      );
    }
    counts.written += batch.length;
  };

  for await (const message of cursor) {
    if (counts.seen >= LIMIT) break;
    counts.seen += 1;
    const found = legacyAttachmentFor(message, (url) => storage.keyFromUrl(url));
    if (!found) {
      counts.skipped += 1;
      continue;
    }
    pending.push({ messageID: message.messageID, ...found });
    if (pending.length >= BATCH) await flush();
  }
  await flush();

  console.log("\nSummary", {
    ...counts,
    written: APPLY ? counts.written : `${counts.written} (dry run - nothing written)`,
  });
  await mongoose.disconnect();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
