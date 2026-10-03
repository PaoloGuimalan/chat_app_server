/**
 * Direct uploads (reusables/media/uploads.js has the rules).
 *
 *   GET    /media/config                     upload limits + transfer settings
 *   POST   /media/uploads                    { purpose, files: [{name, size, type}], context? }
 *            -> uploads: [{ uploadID, name, fileUrl, messageID?, mode, ... }] where
 *               mode "single" carries { method, url, headers } and "multipart"
 *               { partSize, parts: [{ n, size, method, url, headers }] }
 *   POST   /media/uploads/complete           { uploads: [{ uploadID, parts?: [{n, etag}] }] }
 *   POST   /media/uploads/:uploadID/parts    { parts?: [n] } - fresh part links
 *   DELETE /media/uploads/:uploadID          drop an upload nothing uses yet
 *
 * The client sends the bytes to the links these return, never to this server.
 */
const express = require("express");
const { jwtchecker } = require("../../reusables/hooks/jwthelper");
const { getMediaConfig } = require("../../reusables/media/config");
const {
  createUploads,
  completeUploads,
  refreshParts,
  cancelUpload,
} = require("../../reusables/media/uploads");

const router = express.Router();

const sendError = (res, err) => {
  if (!err.status) console.log("[media]", err);
  res
    .status(err.status || 500)
    .send({ status: false, message: err.status ? err.message : "Upload failed" });
};

// Public: clients load it on every boot, before anything is uploaded, and it
// says nothing that isn't already enforced in the open.
router.get("/config", async (req, res) => {
  const { limits, transfer } = await getMediaConfig();
  res.set("Cache-Control", "public, max-age=60");
  res.send({ status: true, limits, transfer });
});

router.post("/uploads", jwtchecker, async (req, res) => {
  try {
    const uploads = await createUploads({
      accountID: req.params.id,
      entityID: req.params.entity_id,
      purpose: req.body?.purpose,
      files: req.body?.files,
      context: req.body?.context,
    });
    res.send({ status: true, uploads });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/uploads/complete", jwtchecker, async (req, res) => {
  try {
    const results = await completeUploads({
      accountID: req.params.id,
      uploads: req.body?.uploads,
    });
    res.send({ status: results.every((r) => r.ok), results });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/uploads/:uploadID/parts", jwtchecker, async (req, res) => {
  try {
    const targets = await refreshParts({
      accountID: req.params.id,
      uploadID: req.params.uploadID,
      parts: req.body?.parts,
    });
    res.send({ status: true, ...targets });
  } catch (err) {
    sendError(res, err);
  }
});

router.delete("/uploads/:uploadID", jwtchecker, async (req, res) => {
  try {
    await cancelUpload({ accountID: req.params.id, uploadID: req.params.uploadID });
    res.send({ status: true });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
