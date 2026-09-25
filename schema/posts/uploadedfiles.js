const mongoose = require("mongoose");

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
});

// Moment creation looks an upload up by its URL (momentMedia.assertOwnUpload)
// - without this every lookup scanned the whole collection. Built by
// mongoose's autoIndex when the server starts.
uploadedfiles.index({ "fileDetails.data": 1 });

module.exports = mongoose.model("UploadedFiles", uploadedfiles, "files");
