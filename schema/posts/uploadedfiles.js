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

module.exports = mongoose.model("UploadedFiles", uploadedfiles, "files");
