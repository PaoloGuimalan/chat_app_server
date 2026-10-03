const mongoose = require("mongoose");

/**
 * One stored file.
 *
 * Two generations share the collection. Legacy records (no `version`) were
 * written by the upload-through-Node paths and carry only the first block.
 * Version 2 records come from the direct-upload flow (reusables/media/
 * uploads.js) and fill the legacy fields too - fileDetails.data is the public
 * URL, fileType the type, action the purpose - so every existing reader
 * (momentMedia's own-upload check, moderation) keeps working on them.
 */
const uploadedfiles = mongoose.Schema({
  fileID: { type: mongoose.Schema.Types.Mixed, require: true },
  fileName: { type: mongoose.Schema.Types.Mixed, require: true },
  foreignID: [{ type: mongoose.Schema.Types.Mixed, require: true }],
  fileDetails: {
    data: { type: mongoose.Schema.Types.Mixed, require: true },
  },
  fileOrigin: { type: mongoose.Schema.Types.Mixed, require: true },
  fileType: { type: mongoose.Schema.Types.Mixed, require: true },
  action: { type: mongoose.Schema.Types.Mixed, require: true },
  dateUploaded: { type: mongoose.Schema.Types.Mixed, require: true },

  // ---- version 2 ----
  version: { type: Number },
  // pending   upload link handed out, bytes not confirmed yet
  // ready     confirmed in storage, not used by anything yet
  // attached  used by at least one post / message / comment
  // held      its content was reported; never deleted automatically for now
  // deleted   removed from storage
  status: { type: String },
  purpose: { type: String },
  ownerAccount: { type: String },
  ownerEntity: { type: String },
  provider: { type: String },
  key: { type: String },
  // The real file name, cleaned - what a client shows and a download is
  // saved as. Also the last segment of the key.
  name: { type: String },
  size: { type: Number },
  mime: { type: String },
  // image | video | audio | file
  kind: { type: String },
  // What uses it: [{ type: "post" | "message" | "comment", id }]
  attachedTo: [{ _id: false, type: { type: String }, id: { type: String } }],
  // Where it belongs, checked at upload time.
  context: {
    conversationID: { type: String },
    realmID: { type: String },
  },
  // A message file's message id, chosen at upload time (it names the folder).
  reservedMessageID: { type: String },
  multipart: {
    uploadId: { type: String },
    partSize: { type: Number },
    partCount: { type: Number },
  },
  holdReason: { type: String },
  createdAt: { type: Date },
  completedAt: { type: Date },
  deletedAt: { type: Date },
});

// Moment creation and the own-upload check look an upload up by its URL -
// without this every lookup scanned the whole collection. Built by
// mongoose's autoIndex when the server starts.
uploadedfiles.index({ "fileDetails.data": 1 });
// The cleanup job's sweeps (stale pending, unattached ready).
uploadedfiles.index({ status: 1, createdAt: 1 }, { sparse: true });
// Releasing a deleted post/message/comment's files.
uploadedfiles.index({ "attachedTo.type": 1, "attachedTo.id": 1 }, { sparse: true });
uploadedfiles.index({ key: 1 }, { sparse: true });

module.exports = mongoose.model("UploadedFiles", uploadedfiles, "files");
