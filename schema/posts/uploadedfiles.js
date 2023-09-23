const mongoose = require("mongoose")

const uploadedfiles = mongoose.Schema({
    filesID: { type: mongoose.Schema.Types.Mixed, require: true },
    fileDetails: {
        data: { type: mongoose.Schema.Types.Mixed, require: true }
    },
    fileOrigin: { type: mongoose.Schema.Types.Mixed, require: true },
    fileType: { type: mongoose.Schema.Types.Mixed, require: true },
    action: { type: mongoose.Schema.Types.Mixed, require: true },
    dateUploaded: {
        time: { type: mongoose.Schema.Types.Mixed, require: true },
        date: { type: mongoose.Schema.Types.Mixed, require: true }
    },
})

module.exports = mongoose.model("UploadedFiles", uploadedfiles, "files")