/**
 * Direct uploads: the client sends bytes straight to storage, and this
 * service only hands out the links, confirms what arrived, and records it.
 *
 *   createUploads    check the purpose, limits and permission; record each
 *                    file as pending; return one upload link, or one per part
 *   refreshParts     new links for parts whose links expired
 *   completeUploads  join the parts, check size and real type, mark ready
 *   cancelUpload     drop an upload nothing uses yet
 *
 * Then the feature that uses a file (a post, a message, a comment) proves it
 * is the caller's own ready upload (resolveAttachable) and records itself on
 * it (attachRecords) - which is what deletion later reads.
 *
 * Storage keys keep the file's real name inside a folder nobody can guess:
 *   messages            uploads/messages/<conversation>/<message id>/<name>
 *   realm avatar/cover  uploads/realms/<realm>/<random>/<name>
 *   comments            uploads/comments/<account>/<random>/<name>
 *   everything else     uploads/entries/<account>/<random>/<name>
 */
const { randomUUID } = require("crypto");
const fileTypeMime = require("file-type-mime");
const UploadedFiles = require("../../schema/posts/uploadedfiles");
const storage = require("./storageProvider");
const { getMediaConfig, limitFor, typeAllowed, transferPlan } = require("./config");
const { pickContentType, dispositionFor } = require("../hooks/contentType");
const { checkExistingFileID } = require("../models/files");
const { checkExistingMessageID } = require("../models/messages");
const { isRealmMember } = require("../models/realms");
const { hasPermission } = require("../hooks/permissionChecker");
const makeID = require("../hooks/makeID");
const { cleanFileName, kindOf } = require("./fileNames");
const dateGetter = require("../hooks/getDate");

class MediaUploadError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const MAX_FILES_PER_REQUEST = 10;
// Enough of a file to recognise every format file-type-mime knows.
const SNIFF_BYTES = 4100;

const MESSAGE_PURPOSES = new Set(["message", "voice_note"]);

/**
 * The message's messageType, in the shape every installed client already
 * renders: exactly "image" for a photo, the real type otherwise (they test
 * it for "video" and "audio").
 */
const messageTypeFor = (record) =>
  record.kind === "image" ? "image" : record.mime || "application/octet-stream";

/** What a message stores about its file - the clients read only this. */
const attachmentFor = (record) => ({
  fileId: record.fileID,
  url: record.fileDetails.data,
  name: record.name,
  mime: record.mime,
  kind: record.kind,
  size: record.size,
  status: "available",
});

/** Whether a sniffed type is consistent with the declared one. */
const typesAgree = (declared, detected) => {
  if (!detected) return true; // plain text, CSV: nothing to contradict
  const [dTop] = String(declared).split("/");
  const [sTop] = String(detected).split("/");
  if (dTop === sTop) return true;
  // A sound-only WebM/MP4 container sniffs as video.
  return dTop === "audio" && sTop === "video";
};

const keyFor = ({ purpose, accountID, context, messageID, folderID, name }) => {
  if (MESSAGE_PURPOSES.has(purpose)) {
    return `uploads/messages/${context.conversationID}/${messageID}/${name}`;
  }
  if (purpose === "comment") return `uploads/comments/${accountID}/${folderID}/${name}`;
  if ((purpose === "avatar" || purpose === "cover") && context.realmID) {
    return `uploads/realms/${context.realmID}/${folderID}/${name}`;
  }
  return `uploads/entries/${accountID}/${folderID}/${name}`;
};

/** Throws unless the caller may upload into this context. */
const assertContext = async ({ purpose, entityID, context }) => {
  if (MESSAGE_PURPOSES.has(purpose)) {
    if (!context.conversationID) throw new MediaUploadError("Missing conversation");
    try {
      await isRealmMember(context.conversationID, entityID);
    } catch {
      throw new MediaUploadError("You do not have access to this conversation", 403);
    }
    return;
  }
  if (context.realmID) {
    if (purpose !== "avatar" && purpose !== "cover") {
      throw new MediaUploadError("Unexpected realm");
    }
    if (!(await hasPermission(entityID, "realm.media.update", context.realmID))) {
      throw new MediaUploadError("You do not have permission to make this action.", 403);
    }
  }
};

const cleanContext = (raw) => {
  const context = {};
  for (const field of ["conversationID", "realmID"]) {
    const value = raw?.[field];
    if (value === undefined || value === null || value === "") continue;
    // Both name a storage folder.
    if (!/^[\w-]{1,150}$/.test(String(value))) throw new MediaUploadError(`Invalid ${field}`);
    context[field] = String(value);
  }
  return context;
};

/** The link(s) a client needs for one upload record. */
const targetsFor = async (record, partNumbers = null) => {
  if (!record.multipart?.uploadId) {
    return {
      mode: "single",
      ...(await storage.singleUploadTarget({
        key: record.key,
        contentType: record.fileType,
        disposition: dispositionFor(record.fileType, record.name),
        size: record.size,
      })),
    };
  }
  const { partSize, partCount, uploadId } = record.multipart;
  const wanted = partNumbers || Array.from({ length: partCount }, (_, i) => i + 1);
  const parts = wanted.map((n) => ({
    n,
    size: n < partCount ? partSize : record.size - partSize * (partCount - 1),
  }));
  return {
    mode: "multipart",
    partSize,
    parts: await storage.partTargets({ key: record.key, uploadId, parts }),
  };
};

const createUploads = async ({ accountID, entityID, purpose, files, context: rawContext }) => {
  const limit = await limitFor(String(purpose || ""));
  if (!limit) throw new MediaUploadError("Unknown upload purpose");
  if (!Array.isArray(files) || files.length === 0) throw new MediaUploadError("No files");
  if (files.length > MAX_FILES_PER_REQUEST) {
    throw new MediaUploadError(`At most ${MAX_FILES_PER_REQUEST} files at a time`);
  }

  const context = cleanContext(rawContext);
  const checked = files.map((file) => {
    const size = Number(file?.size);
    if (!Number.isInteger(size) || size <= 0) throw new MediaUploadError("Invalid file size");
    if (size > limit.maxBytes) {
      throw new MediaUploadError(`Files here can be at most ${limit.maxMB}MB`, 413);
    }
    const contentType = pickContentType(null, file?.type);
    if (!typeAllowed(contentType, limit.types)) {
      throw new MediaUploadError("This type of file can't be uploaded here", 415);
    }
    return { size, contentType, name: cleanFileName(file?.name, contentType) };
  });

  await assertContext({ purpose, entityID, context });
  const { transfer } = await getMediaConfig();

  return Promise.all(
    checked.map(async ({ size, contentType, name }) => {
      const messageID = MESSAGE_PURPOSES.has(purpose)
        ? await checkExistingMessageID(makeID(30))
        : undefined;
      const key = keyFor({
        purpose,
        accountID,
        context,
        messageID,
        folderID: randomUUID(),
        name,
      });
      const plan = transferPlan(size, transfer);
      const multipart =
        plan.mode === "multipart"
          ? {
              uploadId: await storage.startMultipart({
                key,
                contentType,
                disposition: dispositionFor(contentType, name),
              }),
              partSize: plan.partSize,
              partCount: plan.parts.length,
            }
          : undefined;

      const record = await UploadedFiles.create({
        fileID: await checkExistingFileID(`FILE_${makeID(20)}`),
        fileName: name,
        foreignID: [String(accountID), String(entityID)],
        fileDetails: { data: storage.publicUrl(key) },
        fileOrigin: storage.name,
        fileType: contentType,
        action: purpose,
        dateUploaded: dateGetter(),
        version: 2,
        status: "pending",
        purpose,
        ownerAccount: String(accountID),
        ownerEntity: String(entityID),
        provider: storage.name,
        key,
        name,
        size,
        mime: contentType,
        kind: kindOf(contentType),
        attachedTo: [],
        context,
        reservedMessageID: messageID,
        multipart,
        createdAt: new Date(),
      });

      return {
        uploadID: record.fileID,
        name,
        // The file's public link once uploaded; `url` (below) is where to send it.
        fileUrl: record.fileDetails.data,
        ...(messageID ? { messageID } : {}),
        ...(await targetsFor(record)),
      };
    }),
  );
};

const ownPending = async (accountID, uploadID) => {
  const record = await UploadedFiles.findOne({ fileID: uploadID, version: 2 });
  if (!record || record.ownerAccount !== String(accountID)) {
    throw new MediaUploadError("Upload not found", 404);
  }
  if (record.status !== "pending") throw new MediaUploadError("Upload already finished", 409);
  return record;
};

const refreshParts = async ({ accountID, uploadID, parts }) => {
  const record = await ownPending(accountID, uploadID);
  if (!record.multipart?.uploadId) return targetsFor(record);
  const count = record.multipart.partCount;
  const wanted = Array.isArray(parts) && parts.length
    ? [...new Set(parts.map(Number))].filter((n) => Number.isInteger(n) && n >= 1 && n <= count)
    : null;
  return targetsFor(record, wanted);
};

/** Removes a file that failed its checks, and marks the record. */
const discard = async (record, reason) => {
  try {
    if (record.multipart?.uploadId) {
      await storage.abortMultipart({ key: record.key, uploadId: record.multipart.uploadId });
    }
    await storage.remove(record.key);
  } catch (err) {
    console.log("[media] discard failed, the cleanup job will retry:", err.message || err);
    return;
  }
  record.status = "deleted";
  record.deletedAt = new Date();
  record.holdReason = reason;
  await record.save();
};

/**
 * Joins a multipart upload's parts into the file, from the parts storage
 * itself reports (see storage.listParts) - any ETags a client sends are
 * ignored. Each part's size was signed into its link, so storage already
 * refused a wrong one; the whole file's size is checked after.
 */
const joinParts = async (record) => {
  const { uploadId, partCount } = record.multipart;
  let stored;
  try {
    stored = await storage.listParts({ key: record.key, uploadId });
  } catch (err) {
    throw new MediaUploadError(`Couldn't read the parts: ${err.message || err}`, 409);
  }
  const byNumber = new Map(stored.map((p) => [p.n, p]));
  const numbers = Array.from({ length: partCount }, (_, i) => i + 1);
  const missing = numbers.filter((n) => !byNumber.has(n));
  if (missing.length) {
    throw new MediaUploadError(`Parts ${missing.join(", ")} haven't arrived yet`, 409);
  }
  try {
    await storage.completeMultipart({
      key: record.key,
      uploadId,
      parts: numbers.map((n) => byNumber.get(n)),
    });
  } catch (err) {
    throw new MediaUploadError(`Couldn't join the parts: ${err.message || err}`, 409);
  }
};

const completeOne = async (accountID, { uploadID }) => {
  const record = await ownPending(accountID, uploadID);

  // A multipart file exists only once joined - so on a retry (say, publishing
  // failed last time) it's already there and there is nothing left to join.
  if (record.multipart?.uploadId && !(await storage.head(record.key))) {
    await joinParts(record);
  }

  const stored = await storage.head(record.key);
  if (!stored) throw new MediaUploadError("The file hasn't arrived yet", 409);
  if (stored.size !== record.size) {
    await discard(record, "size_mismatch");
    throw new MediaUploadError("The file's size doesn't match what was declared");
  }

  const detected = fileTypeMime.parse(
    await storage.readStart(record.key, Math.min(SNIFF_BYTES, stored.size)),
  )?.mime;
  const limit = await limitFor(record.purpose);
  const mime = pickContentType(detected, record.fileType);
  if (!typesAgree(record.fileType, detected) || (limit && !typeAllowed(mime, limit.types))) {
    await discard(record, "type_mismatch");
    throw new MediaUploadError("The file isn't the type it claimed to be", 415);
  }

  // Uploaded private; public only now that it has passed the checks. A
  // failure leaves the record pending, so the client can simply retry.
  try {
    await storage.makePublic(record.key);
  } catch (err) {
    throw new MediaUploadError(`Couldn't publish the file: ${err.message || err}`, 503);
  }

  record.status = "ready";
  record.completedAt = new Date();
  record.size = stored.size;
  record.mime = mime;
  record.fileType = mime; // the legacy field older readers check
  record.kind = kindOf(mime);
  await record.save();

  return {
    uploadID: record.fileID,
    fileUrl: record.fileDetails.data,
    name: record.name,
    mime: record.mime,
    kind: record.kind,
    size: record.size,
    ...(record.reservedMessageID ? { messageID: record.reservedMessageID } : {}),
  };
};

/** Confirms each upload; one failing doesn't stop the others. */
const completeUploads = async ({ accountID, uploads }) => {
  if (!Array.isArray(uploads) || uploads.length === 0) throw new MediaUploadError("No uploads");
  if (uploads.length > MAX_FILES_PER_REQUEST) {
    throw new MediaUploadError(`At most ${MAX_FILES_PER_REQUEST} files at a time`);
  }
  const results = await Promise.allSettled(uploads.map((u) => completeOne(accountID, u)));
  return results.map((result, i) =>
    result.status === "fulfilled"
      ? { ok: true, ...result.value }
      : {
          ok: false,
          uploadID: uploads[i]?.uploadID,
          status: result.reason?.status || 500,
          message: result.reason?.message || "Couldn't finish the upload",
        },
  );
};

const cancelUpload = async ({ accountID, uploadID }) => {
  const record = await UploadedFiles.findOne({ fileID: uploadID, version: 2 });
  if (!record || record.ownerAccount !== String(accountID)) {
    throw new MediaUploadError("Upload not found", 404);
  }
  if (record.status === "deleted") return;
  if (record.status !== "pending" && record.status !== "ready") {
    throw new MediaUploadError("This file is already in use", 409);
  }
  await discard(record, "cancelled");
};

/** A link as sent, decoded, and re-encoded - a client may have URI-encoded
 * the name (spaces, non-ASCII) or not, and both mean the same file. */
const urlVariants = (url) => {
  let decoded = url;
  try {
    decoded = decodeURI(url);
  } catch {
    // Not valid percent-encoding: only the link as sent can match.
  }
  return [...new Set([url, decoded, encodeURI(decoded)])];
};

/**
 * The upload records behind `urls`, checked: every link must be a file the
 * caller uploaded through /media/uploads, confirmed, and of an allowed
 * purpose. Anything else - an external link, someone else's file, a file
 * from the retired upload paths - is refused.
 */
const resolveAttachable = async ({ urls, accountID, purposes = null }) => {
  const wanted = [...new Set((urls || []).filter((u) => typeof u === "string" && u))];
  if (!wanted.length) return [];
  const records = await UploadedFiles.find({
    version: 2,
    "fileDetails.data": { $in: wanted.flatMap(urlVariants) },
  });
  const byUrl = new Map(records.map((r) => [r.fileDetails.data, r]));
  for (const url of wanted) {
    if (!urlVariants(url).some((v) => byUrl.has(v))) {
      throw new MediaUploadError("Files must be uploaded to Chatterloop first");
    }
  }
  for (const record of records) {
    if (record.ownerAccount !== String(accountID)) {
      throw new MediaUploadError("You can only use files you uploaded", 403);
    }
    if (record.status !== "ready" && record.status !== "attached") {
      throw new MediaUploadError("That file isn't ready to use");
    }
    if (purposes && !purposes.includes(record.purpose)) {
      throw new MediaUploadError("That file was uploaded for something else");
    }
  }
  return records;
};

/** Records `target` ({ type, id }) as a user of each file. Never throws. */
const attachRecords = async (records, target) => {
  const ids = (records || []).map((r) => r._id);
  if (!ids.length) return;
  try {
    await UploadedFiles.updateMany(
      { _id: { $in: ids } },
      {
        $addToSet: { attachedTo: { type: target.type, id: String(target.id) } },
        $set: { status: "attached" },
      },
    );
  } catch (err) {
    console.log("[media] attaching files failed:", err.message || err);
  }
};

/**
 * A message file's upload, by id, ready to become its message: the caller's,
 * confirmed, uploaded for this conversation, with its reserved message id.
 */
const resolveMessageUploads = async ({ accountID, conversationID, uploadIDs }) => {
  const ids = [...new Set((uploadIDs || []).map(String))];
  if (!ids.length) throw new MediaUploadError("No uploads");
  if (ids.length > MAX_FILES_PER_REQUEST) {
    throw new MediaUploadError(`At most ${MAX_FILES_PER_REQUEST} files at a time`);
  }
  const records = await UploadedFiles.find({ version: 2, fileID: { $in: ids } });
  const byID = new Map(records.map((r) => [r.fileID, r]));
  return ids.map((id) => {
    const record = byID.get(id);
    if (!record || record.ownerAccount !== String(accountID)) {
      throw new MediaUploadError("Upload not found", 404);
    }
    if (record.status !== "ready") throw new MediaUploadError("That file isn't ready to send");
    if (!MESSAGE_PURPOSES.has(record.purpose) || !record.reservedMessageID) {
      throw new MediaUploadError("That file wasn't uploaded for a message");
    }
    if (record.context?.conversationID !== String(conversationID)) {
      throw new MediaUploadError("That file was uploaded for another conversation");
    }
    return record;
  });
};

/**
 * One upload by id, ready to use: the caller's, confirmed, of an allowed
 * purpose - and, when it was uploaded for a realm, for this realm.
 */
const resolveUploadByID = async ({ accountID, uploadID, purposes, realmID = null }) => {
  if (!uploadID) throw new MediaUploadError("Missing upload");
  const record = await UploadedFiles.findOne({ version: 2, fileID: String(uploadID) });
  if (!record || record.ownerAccount !== String(accountID)) {
    throw new MediaUploadError("Upload not found", 404);
  }
  if (record.status !== "ready" && record.status !== "attached") {
    throw new MediaUploadError("That file isn't ready to use");
  }
  if (purposes && !purposes.includes(record.purpose)) {
    throw new MediaUploadError("That file was uploaded for something else");
  }
  if (record.context?.realmID && realmID && record.context.realmID !== String(realmID)) {
    throw new MediaUploadError("That file was uploaded for another realm");
  }
  return record;
};

module.exports = {
  MediaUploadError,
  resolveUploadByID,
  createUploads,
  refreshParts,
  completeUploads,
  cancelUpload,
  resolveAttachable,
  resolveMessageUploads,
  attachRecords,
  attachmentFor,
  messageTypeFor,
  cleanFileName,
  kindOf,
  typesAgree,
  keyFor,
};
