/**
 * One-off backfill: resolves link previews for existing text messages that
 * predate the link-preview feature, or predate a later addition to its
 * response shape (oEmbed/embed_type, then embed_layout), and never got an
 * up-to-date linkPreview field written onto them by the live /sendMessage
 * flow.
 *
 * Staleness marker: any text message whose content looks like it contains
 * a URL, but whose stored linkPreview object (if any) is missing
 * `embed_layout` - that key is always present (even as null) on anything
 * resolved by the current pipeline (it's set alongside embed_type in the
 * same fetch_oembed() dict, so its absence supersedes checking embed_type
 * alone), so its absence means "resolved before this pipeline existed, or
 * before this field was added to it, or never resolved at all". Bump this
 * marker again the next time link_preview.py's response shape gains a
 * field older stored messages should pick up.
 *
 * Usage:
 *   node scripts/backfillLinkPreviews.js              # runs the backfill
 *   node scripts/backfillLinkPreviews.js --dry-run     # reports scope only
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Axios = require("axios");
const MongooseConnection = require("../connections/index");
const UserMessage = require("../schema/messages/message");

const LINK_PREVIEW_SERVICE_URL = process.env.LINK_PREVIEW_SERVICE_URL;
const INTERNAL_SERVICE_SECRET = process.env.INTERNAL_SERVICE_SECRET;

const DRY_RUN = process.argv.includes("--dry-run");
const PROGRESS_EVERY = 25;

async function resolvePreviewForMessage(message) {
  try {
    const response = await Axios.post(
      LINK_PREVIEW_SERVICE_URL,
      { text: message.content },
      {
        headers: { "X-Internal-Service-Secret": INTERNAL_SERVICE_SECRET },
        timeout: 6000,
      },
    );
    const linkPreview = response.data;
    return linkPreview && linkPreview.url ? linkPreview : null;
  } catch (err) {
    console.log(
      `[backfill] resolve failed for messageID=${message.messageID}:`,
      err.message || err,
    );
    return null;
  }
}

async function run() {
  if (!LINK_PREVIEW_SERVICE_URL || !INTERNAL_SERVICE_SECRET) {
    console.error(
      "[backfill] LINK_PREVIEW_SERVICE_URL / INTERNAL_SERVICE_SECRET not set - aborting.",
    );
    process.exit(1);
  }

  await mongoose.connect(MongooseConnection.url, MongooseConnection.params);
  console.log("[backfill] connected to MongoDB");

  const query = {
    messageType: "text",
    content: { $regex: /https?:\/\// },
    isDeleted: { $ne: true },
    "linkPreview.embed_layout": { $exists: false },
  };

  const total = await UserMessage.countDocuments(query);
  console.log(
    `[backfill] ${total} candidate message(s) found${DRY_RUN ? " (dry run, no writes)" : ""}`,
  );

  if (DRY_RUN || total === 0) {
    await mongoose.disconnect();
    process.exit(0);
  }

  let processed = 0;
  let updated = 0;
  let skippedNoUrl = 0;
  let failed = 0;

  const cursor = UserMessage.find(query).cursor();

  for await (const message of cursor) {
    processed++;
    const linkPreview = await resolvePreviewForMessage(message);

    if (!linkPreview) {
      skippedNoUrl++;
    } else {
      try {
        await UserMessage.updateOne(
          { _id: message._id },
          { $set: { linkPreview } },
        );
        updated++;
      } catch (err) {
        failed++;
        console.log(
          `[backfill] failed to persist messageID=${message.messageID}:`,
          err.message || err,
        );
      }
    }

    if (processed % PROGRESS_EVERY === 0) {
      console.log(
        `[backfill] progress: ${processed}/${total} processed, ${updated} updated so far`,
      );
    }
  }

  console.log(
    `[backfill] done. processed=${processed} updated=${updated} skipped(no-url-found)=${skippedNoUrl} failed=${failed}`,
  );

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error("[backfill] fatal error:", err);
  process.exit(1);
});
