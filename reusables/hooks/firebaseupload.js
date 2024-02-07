const { FIREBASE_TYPE, FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY_ID, FIREBASE_PRIVATE_KEY, FIREBASE_CLIENT_EMAIL, FIREBASE_CLIENT_ID, FIREBASE_AUTH_URI, FIREBASE_TOKEN_URI, FIREBASE_AUTH_PROVIDER_X509_CERT_URL, FIREBASE_CLIENT_X509_CERT_URL, FIREBASE_UNIVERSE_DOMAIN, FIREBASE_STORAGE_BUCKET } = require("../vars/firebasevars");
const { base64ToArrayBuffer } = require("./base64toFile");
const firebase = require("firebase-admin")
const fstorage = require("firebase-admin/storage");
const makeid = require("./makeID");
const { checkExistingFileID } = require("../models/files");
const timeGetter = require("./getTime");
const dateGetter = require("./getDate");

const UploadedFiles = require("../../schema/posts/uploadedfiles");

const firebaseAdminConfig = {
    type: FIREBASE_TYPE,
    project_id: FIREBASE_PROJECT_ID,
    private_key_id: FIREBASE_PRIVATE_KEY_ID,
    private_key: JSON.parse(FIREBASE_PRIVATE_KEY).privateKey,
    client_email: FIREBASE_CLIENT_EMAIL,
    client_id: FIREBASE_CLIENT_ID,
    auth_uri: FIREBASE_AUTH_URI,
    token_uri: FIREBASE_TOKEN_URI,
    auth_provider_x509_cert_url: FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
    client_x509_cert_url: FIREBASE_CLIENT_X509_CERT_URL,
    universe_domain: FIREBASE_UNIVERSE_DOMAIN
  }

const firebaseinit = firebase.initializeApp({
    credential: firebase.credential.cert(firebaseAdminConfig),
    storageBucket: FIREBASE_STORAGE_BUCKET
});
const storage = fstorage.getStorage(firebaseinit.storage().app)

const uploadFirebase = async (mp) => {
    var arr = mp.reference.split(',')
    var fileTypeBase = arr[0].match(/:(.*?);/)[1]
    var fileType = arr[0].match(/:(.*?);/)[1].split("/")[1]

    var fileIDTypeChecker = !mp.referenceMediaType.includes("audio") && !mp.referenceMediaType.includes("video") && !mp.referenceMediaType.includes("image") ? "" : `.${fileType}`
    let tosplitname = mp.name ? mp.name : ""
    let split = tosplitname.split(".");
    let splicedStr = split.slice(0, split.length - 1).join(".")
    var fileNameChecker = mp.name ? `${splicedStr}###` : 'IMG_'
    var fileNameCheckerEncoded = mp.name ? `${encodeURIComponent(splicedStr)}###` : 'IMG_'
    var fileIDRandomStamp = makeid(20);
    var fileID = `${fileNameChecker}${fileIDRandomStamp}${fileIDTypeChecker}`
    var fileIDEncoded = `${fileNameCheckerEncoded}${fileIDRandomStamp}${fileIDTypeChecker}`

    var contentFinal = mp.reference.split('base64,')[1]
    var fileFinal = base64ToArrayBuffer(contentFinal)
    var finalBuffer = Buffer.from(fileFinal)

    const folderDesignation = {
        image: 'imgs',
        video: 'videos',
        audio: 'audios',
        any: 'files'
    }

    var fileTypeChecker = !mp.referenceMediaType.includes("audio") && !mp.referenceMediaType.includes("video") && !mp.referenceMediaType.includes("image") ? folderDesignation["any"] : folderDesignation[mp.referenceMediaType.split("/")[0]] 
    var finalPathwithID = `${fileTypeChecker}/${fileID}`
    var finalPathwithIDEncoded = `${fileTypeChecker}/${fileIDEncoded}`

    const file = storage.bucket().file(finalPathwithID)

    return await file.save(finalBuffer, {
        contentType: fileTypeBase,
        public: true
    }).then((url) => {
        const publicUrl = mp.referenceMediaType.includes("image") ? `https://storage.googleapis.com/${FIREBASE_STORAGE_BUCKET}/${finalPathwithID}` : `https://storage.googleapis.com/${FIREBASE_STORAGE_BUCKET}/${finalPathwithIDEncoded}`;
        return publicUrl;
    }).catch((err) => {
        console.log(err);
        throw new Error(err);
    })
}

const uploadFirebaseMultiple = async (mparray) => {
    var promises = mparray.map(async (mp) => {
        try {
            const url = await uploadFirebase(mp);
            return {
                ...mp,
                reference: url
            };
        } catch (err) {
            console.log(err);
            return null;
        }
    });

    var finisheduploads = await Promise.all(promises);
    finisheduploads = finisheduploads.filter(upload => upload !== null);

    return finisheduploads;
}

const saveFileRecordToDatabase = async (foreignID, fileData, action, fileType, fileOrigin) => {
    const payload = {
        fileID: await checkExistingFileID(`FILE_${makeid(20)}`),
        foreignID: foreignID,
        fileDetails: {
            data: fileData
        },
        fileOrigin: fileOrigin,
        fileType: fileType,
        action: action,
        dateUploaded: {
            time: timeGetter(),
            date: dateGetter()
        }
    }

    const newFile = new UploadedFiles(payload)

    newFile.save().then(() => {

    }).catch((err) => {
        console.log(err)
    })
}

module.exports = {
    firebaseinit,
    storage,
    uploadFirebase,
    uploadFirebaseMultiple,
    saveFileRecordToDatabase
}