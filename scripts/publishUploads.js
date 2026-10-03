/**
 * Makes finished direct uploads publicly readable. For files uploaded before
 * the server started publishing them at completion: the upload link's ACL was
 * ignored by Spaces, so they were stored private and their links answered
 * "AccessDenied".
 *
 *   node scripts/publishUploads.js           # dry run: lists them
 *   node scripts/publishUploads.js --apply   # publish them
 *
 * Only version-2 records that passed their checks (ready / attached / held);
 * never a pending upload, which nobody has vetted yet. Safe to re-run.
 * Runs against the database and bucket in .env - PRODUCTION.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const MongooseConnection = require("../connections/index");
const UploadedFiles = require("../schema/posts/uploadedfiles");
const storage = require("../reusables/media/storageProvider");

const APPLY = process.argv.includes("--apply");

const main = async () => {
  await mongoose.connect(MongooseConnection.url);
  const records = await UploadedFiles.find({
    version: 2,
    status: { $in: ["ready", "attached", "held"] },
  })
    .select({ key: 1, "fileDetails.data": 1 })
    .lean();
  console.log(`${records.length} finished upload(s)${APPLY ? "" : " - DRY RUN, pass --apply"}`);
  let failed = 0;
  for (const record of records) {
    if (!APPLY) {
      console.log(`  would publish ${record.fileDetails.data}`);
      continue;
    }
    try {
      await storage.makePublic(record.key);
      console.log(`  published ${record.fileDetails.data}`);
    } catch (err) {
      failed += 1;
      console.log(`  FAILED ${record.fileDetails.data}: ${err.message || err}`);
    }
  }
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
