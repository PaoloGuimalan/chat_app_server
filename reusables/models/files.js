const UploadedFiles = require("../../schema/posts/uploadedfiles");
const makeid = require("../hooks/makeID");

const checkExistingFileID = async (checkID) => {
    return await UploadedFiles.find({ fileID: checkID}).then((result) => {
        if(result.length > 0){
            checkExistingFileID(`FILE_${makeid(20)}`)
        }
        else{
            return checkID;
        }
    }).catch((err) => {
        console.log(err)
        return false;
    })
}

module.exports = {
    checkExistingFileID
}