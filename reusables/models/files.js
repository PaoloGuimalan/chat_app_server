const UploadedFiles = require("../../schema/posts/uploadedfiles");
const makeid = require("../hooks/makeID");

// The first of `checkID` and fresh FILE_ ids that no file record uses yet.
// Used to recurse without returning the result, so a collision resolved to
// undefined. Throws if the lookup fails rather than handing back an id that
// was never checked.
const checkExistingFileID = async (checkID) => {
  let candidate = checkID;
  while (await UploadedFiles.exists({ fileID: candidate })) {
    candidate = `FILE_${makeid(20)}`;
  }
  return candidate;
};

module.exports = {
  checkExistingFileID,
};
