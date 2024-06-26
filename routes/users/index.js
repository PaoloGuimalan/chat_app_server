require("dotenv").config()
const express = require("express")
const router = express.Router()
const mongoose = require("mongoose")
const jwt = require("jsonwebtoken")
const Axios = require("axios")
const sse = require("sse-express")
const readable = require('stream').Readable;
const fs = require("fs");
const firebase = require("firebase-admin")
const fstorage = require("firebase-admin/storage");
const { FIREBASE_TYPE, FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY_ID, FIREBASE_PRIVATE_KEY, FIREBASE_CLIENT_EMAIL, FIREBASE_CLIENT_ID, FIREBASE_AUTH_URI, FIREBASE_TOKEN_URI, FIREBASE_AUTH_PROVIDER_X509_CERT_URL, FIREBASE_CLIENT_X509_CERT_URL, FIREBASE_UNIVERSE_DOMAIN, FIREBASE_STORAGE_BUCKET } = require("../../reusables/vars/firebasevars")

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

// const firebaseinit = firebase.initializeApp({
//     credential: firebase.credential.cert(firebaseAdminConfig),
//     storageBucket: FIREBASE_STORAGE_BUCKET
// });
// const storage = fstorage.getStorage(firebaseinit.storage().app)

const UserAccount = require("../../schema/auth/useraccount")
const UserVerification = require("../../schema/auth/userverification")
const UserContacts = require("../../schema/users/contacts")
const UserNotifications = require("../../schema/users/notifications")
const UserMessage = require('../../schema/messages/message')
const UserGroups = require("../../schema/users/groups")
const UserServers = require("../../schema/users/servers");
const UploadedFiles = require("../../schema/posts/uploadedfiles")
const UserSessions = require("../../schema/auth/sessions")

const dateGetter = require("../../reusables/hooks/getDate")
const timeGetter = require("../../reusables/hooks/getTime")
const makeID = require("../../reusables/hooks/makeID")
const { base64ToArrayBuffer, dataURLtoFile } = require("../../reusables/hooks/base64toFile")
const { format } = require("path")
const { GetAllMessageCountInAConversation } = require("../../reusables/models/conversation")
const { sseNotificationsWaiters, ReloadUserNotification, clearASingleSession, ContactListTrigger, SSENotificationsTrigger, MessagesTrigger, ReachCallRecepients, UpdateContactswSessionStatus, CallRejectNotif } = require("../../reusables/hooks/sse")
const { storage } = require("../../reusables/hooks/firebaseupload")
const { CountAllUnreadNotifications } = require("../../reusables/models/notifications")
const makeid = require("../../reusables/hooks/makeID")
const { GetAllReceivers } = require("../../reusables/models/messages")
const { GetServerMembers } = require("../../reusables/models/server")
const { createJWT, jwtchecker, jwtssechecker } = require("../../reusables/hooks/jwthelper")
const producer = require("../../reusables/rabbitmq/producer")
const { SSE_NOTIFICATIONS_TRIGGER, MESSAGES_TRIGGER_LOOPER, CONTACT_LIST_TRIGGER_LOOPER, REACH_CALL_RECEPIENTS_LOOPER, UPDATE_CONTATCS_W_SESSION_STATUS_LOOPER, CALL_REJECT_NOTIF, CALL_REJECT_NOTIF_LOOPER } = require("../../reusables/vars/rabbitmqevents")

const MAILINGSERVICE_DOMAIN = process.env.MAILINGSERVICE
const JWT_SECRET = process.env.JWT_SECRET

router.get('/search/:searchdata', jwtchecker, async (req, res) => {
    const userID = req.params.userID
    const searchdata = req.params.searchdata;
    
    if(searchdata.split("")[0] == "@"){
        await UserAccount.aggregate([
            {
                $match: { 
                    isActivated: true, 
                    isVerified: true, 
                    userID: { $regex: searchdata.split("@")[1], $options: "i" }
                }
            },{
                $lookup:{
                    from: "contacts",
                    // localField: "userID",
                    // foreignField: "users.userID",
                    let: { actionByUserID: "$userID" },
                    pipeline: [
                        {
                          $match: {
                            $expr: {
                              $or: [
                                // {
                                //   $and: [
                                //     { $eq: [userID, "$actionBy"] },
                                //     { $in: [userID, "$users.userID"] }
                                //   ]
                                // },
                                {
                                  $and: [
                                    { $eq: [userID, "$actionBy"] },
                                    { $in: ["$$actionByUserID", "$users.userID"] }
                                  ]
                                },
                                {
                                  $and: [
                                    { $eq: ["$$actionByUserID", "$actionBy"] },
                                    { $in: [userID, "$users.userID"] }
                                  ]
                                }
                              ]
                            }
                          }
                        }
                    ],
                    as: "contacts"
                }
            },{
                $unwind: {
                  path: "$contacts",
                  preserveNullAndEmptyArrays: true
                }
            },{
                $lookup:{
                    from: "notifications",
                    localField: "contacts.contactID",
                    foreignField: "referenceID",
                    as: "notification"
                }
            },{
                $project:{
                    password: 0,
                    birthdate: 0,
                    gender: 0,
                    email: 0,
                    isActivated: 0,
                    isVerified: 0
                }
            }
        ]).then((result) => {
            // console.log(result)
            var encodedResult = jwt.sign({
                searchresults: result
            }, JWT_SECRET, {
                expiresIn: 60 * 60 * 24 * 7
            })

            res.send({status: true, result: encodedResult})
        }).catch((err) => {
            console.log(err)
            res.send({status: false, message: `Error searching for ${searchdata}`})
        })
    }
    else{
        await UserAccount.aggregate([
            {
                $match: { 
                    isActivated: true, 
                    isVerified: true, 
                    $or: [
                        {"fullname.firstName": { $regex: searchdata, $options: "i" }},
                        {"fullname.middleName": { $regex: searchdata, $options: "i" }},
                        {"fullname.lastName": { $regex: searchdata, $options: "i" }}
                    ] 
                }
            },{
                $lookup:{
                    from: "contacts",
                    // localField: "userID",
                    // foreignField: "users.userID",
                    let: { actionByUserID: "$userID" },
                    pipeline: [
                        {
                          $match: {
                            $expr: {
                              $or: [
                                // {
                                //   $and: [
                                //     { $eq: [userID, "$actionBy"] },
                                //     { $in: [userID, "$users.userID"] }
                                //   ]
                                // },
                                {
                                  $and: [
                                    { $eq: [userID, "$actionBy"] },
                                    { $in: ["$$actionByUserID", "$users.userID"] }
                                  ]
                                },
                                {
                                  $and: [
                                    { $eq: ["$$actionByUserID", "$actionBy"] },
                                    { $in: [userID, "$users.userID"] }
                                  ]
                                }
                              ]
                            }
                          }
                        }
                    ],
                    as: "contacts"
                }
            },{
                $unwind: {
                  path: "$contacts",
                  preserveNullAndEmptyArrays: true
                }
            },{
                $lookup:{
                    from: "notifications",
                    localField: "contacts.contactID",
                    foreignField: "referenceID",
                    as: "notification"
                }
            },{
                $project:{
                    password: 0,
                    birthdate: 0,
                    gender: 0,
                    email: 0,
                    isActivated: 0,
                    isVerified: 0
                }
            }
        ]).then((result) => {
            // console.log(result)
            var encodedResult = jwt.sign({
                searchresults: result
            }, JWT_SECRET, {
                expiresIn: 60 * 60 * 24 * 7
            })

            res.send({status: true, result: encodedResult})
        }).catch((err) => {
            console.log(err)
            res.send({status: false, message: `Error searching for ${searchdata}`})
        })
    }
})

const sendNotification = async (params, actionlog) => {
    const sendToUser = params.toUserID
    const sendToDetails = params.content.details
    const sendFromUser = params.fromUserID
    const type = params.type
    const newNotif = new UserNotifications(params)
    
    newNotif.save().then(async () => {
        SSENotificationsTrigger(type, {
            sendToUser: sendToUser,
            sendFromUser: sendFromUser
        }, {
            sendToDetails: sendToDetails,
            actionlog: actionlog
        })

        await producer.publishMessage("INFO:CHATTERLOOP", SSE_NOTIFICATIONS_TRIGGER, {
            parameters: {
                type: type,
                ids: {
                    sendToUser: sendToUser,
                    sendFromUser: sendFromUser
                },
                details: {
                    sendToDetails: sendToDetails,
                    actionlog: actionlog
                }
            }
        });
        // SSENotificationsTrigger(type, sendFromUser, actionlog)
    }).catch((err) => { console.log(err) })
}

const checkContactID = async (cnctID) => {
    return await UserContacts.find({contactID: cnctID}).then((result) => {
        if(result.length){
            checkContactID(`${makeID(20)}`)
        }
        else{
            return cnctID;
        }
    }).catch((err) => {
        console.log(err)
        return false;
    })
}

const checkServerID = async (cnctID) => {
    return await UserServers.find({serverID: cnctID}).then((result) => {
        if(result.length){
            checkServerID(`${makeID(20)}`)
        }
        else{
            return cnctID;
        }
    }).catch((err) => {
        console.log(err)
        return false;
    })
}

const checkNotifID = async (ntfID) => {
    return await UserNotifications.find({notificationID: ntfID}).then((result) => {
        if(result.length){
            checkNotifID(`NTF_${makeID(20)}`)
        }
        else{
            return ntfID;
        }
    }).catch((err) => {
        console.log(err)
        return false;
    })
}

const checkContactRequest = async (requesterID, responderID) => {
    return await UserContacts.find({ "users.userID": { $all: [requesterID, responderID] } }).then((result) => {
        if(result.length > 0){
            return false
        }
        else{
            return true
        }
    }).catch((err) => {
        console.log(err)
        return false
    })
}

router.post('/requestContact', jwtchecker, async (req, res) => {
    const userID = req.params.userID
    const token = req.body.token;

    try{
        const decodeToken = jwt.verify(token, JWT_SECRET)

        const contactID = await checkContactID(`${makeID(20)}`)
        const addUserID = decodeToken.addUserID

        const payload = {
            contactID: contactID,
            actionBy: userID,
            actionDate: {
                date: dateGetter(),
                time: timeGetter()
            },
            status: false,
            type: "single",
            users: [
                {
                    userID: userID
                },
                {
                    userID: addUserID
                }
            ]
        }

        if(await checkContactRequest(userID, addUserID)){
            const newContact = new UserContacts(payload)

            newContact.save().then(async () => {
                const awaitNotifID = await checkNotifID(`NTF_${makeID(20)}`)
                const notifParams = {
                    notificationID: awaitNotifID,
                    referenceID: contactID,
                    referenceStatus: false,
                    toUserID: addUserID,
                    fromUserID: userID,
                    content: {
                        headline: `Contact Request`,
                        details: `@${userID} have sent a contact request for you.`,
                    },
                    date: {
                        date: dateGetter(),
                        time: timeGetter()
                    },
                    type: "contact_request"
                }

                sendNotification(notifParams, "You have sent a contact request")

                res.send({ status: true, message: `You have sent a contact request to @${addUserID}` })
            }).catch((err) => {
                res.send({ status: false, message: "Contact request encountered an error!" })
                console.log(err)
            })
        }
    }catch(ex){
        res.send({ status: false, message: "Contact request encountered an error!" })
        console.log(ex)
    }
})

router.post('/readnotifications', jwtchecker, async (req, res) => {
    const userID = req.params.userID;

    if(userID){
        await UserNotifications.updateMany({ toUserID: userID, isRead: false }, { isRead: true }).then(async (result) => {
            ReloadUserNotification(userID, "Notifications has been read");
            await producer.publishMessage("INFO:CHATTERLOOP", "reload_user_notification", {
                parameters: {
                    id: userID,
                    details: "Notifications has been read"
                }
            });
            res.send({status: true, message: "Notifications has been read" });
        }).catch((err) => {
            console.log(err);
            res.send({status: false, message: "Error marking notifications as read" })
        })
    }
    else {
        res.send({status: false, message: "No userID received" })
    }
})

router.get('/getNotifications', jwtchecker, async (req, res) => {
    const userID = req.params.userID
    const UnreadNotificationsTotal =  await CountAllUnreadNotifications(userID);

    await UserNotifications.aggregate([
        {
            $match:{
                toUserID: userID
            }
        },{
            $lookup:{
                from: "useraccount",
                localField: "fromUserID",
                foreignField: "userID",
                as: "fromUser"
            }
        },{
            $unwind:{
                path: "$fromUser",
                preserveNullAndEmptyArrays: true
            }
        },{
            $sort: {_id: -1}
        },{
            $project:{
                "fromUser._id": 0,
                "fromUser.birthdate": 0,
                "fromUser.gender": 0,
                "fromUser.email": 0,
                "fromUser.password": 0,
                "fromUser.dateCreated": 0
            }
        }
    ]).then((result) => {
        // console.log(result)
        var encodedResult = jwt.sign({
            notifications: result,
            totalunread: UnreadNotificationsTotal
        }, JWT_SECRET, {
            expiresIn: 60 * 60 * 24 * 7
        })

        res.send({status: true, result: encodedResult})
    }).catch((err) => {
        console.log(err)
        res.send({status: false, message: "Error retrieving notifications"})
    })
})

const updateNotifStatus = async (type, referenceID, notificationID, toUserID, fromUserID, notifHeadline, notifContent, actionlog) => {
    await UserNotifications.updateOne({ notificationID: notificationID }, { referenceStatus: true }).then(async (result) => {
        const awaitNotifID = await checkNotifID(`NTF_${makeID(20)}`)
        const notifParams = {
            notificationID: awaitNotifID,
            referenceID: referenceID,
            referenceStatus: true,
            toUserID: toUserID,
            fromUserID: fromUserID,
            content: {
                headline: notifHeadline,
                details: notifContent,
            },
            date: {
                date: dateGetter(),
                time: timeGetter()
            },
            type: type
        }
        sendNotification(notifParams, actionlog)
    }).catch((err) => {
        console.log(err)
        res.send({status: false, message: "Error encountered in notifications"})
    })
}

router.post('/declineContactRequest', jwtchecker, async (req, res) => {
    const userID = req.params.userID
    const token = req.body.token;

    try{
        const decodedToken = jwt.verify(token, JWT_SECRET)

        const type = decodedToken.type;
        const notificationID = decodedToken.notificationID;
        const referenceID = decodedToken.referenceID;
        const toUserID = decodedToken.toUserID;
        const fromUserID = decodedToken.fromUserID;

        await UserContacts.deleteOne({ contactID: referenceID }).then(async (result) => {
            res.send({status: true, message: "Contact has been deleted"})
            if(type == "contact_request"){
                const notifHeadline = `Declined Request`
                const notifContent = `${fromUserID} declined your request`
                
                await updateNotifStatus("info_contact_decline", referenceID, notificationID, toUserID, fromUserID, notifHeadline, notifContent, "You declined a contact request")
            }
        }).catch((err) => {
            console.log(err)
            res.send({status: false, message: "Error verifying decline request"})
        })
    }catch(ex){
        console.log(ex)
        res.send({status: false, message: "Error declining request"})
    }
})

router.post('/acceptContactRequest', jwtchecker, async (req, res) => {
    const userID = req.params.userID
    const token = req.body.token;

    try{
        const decodedToken = jwt.verify(token, JWT_SECRET)

        const type = decodedToken.type;
        const notificationID = decodedToken.notificationID;
        const referenceID = decodedToken.referenceID;
        const toUserID = decodedToken.toUserID;
        const fromUserID = decodedToken.fromUserID

        await UserContacts.updateOne({ contactID: referenceID }, { status: true }).then(async (result) => {
            res.send({status: true, message: "Contact has been accepted"})
            const notifHeadline = `Accepted Request`
            const notifContent = `${fromUserID} accepted your request`
                
            await updateNotifStatus("info_contact_accept", referenceID, notificationID, toUserID, fromUserID, notifHeadline, notifContent, "You accepted a contact request")
        }).catch((err) => {
            res.send({status: false, message: "Error verifying accept request"})
            console.log(err)
        })
        
    }catch(ex){
        console.log(ex)
        res.send({status: false, message: "Error accepting request"})
    }
})

router.get('/getContacts', jwtchecker, async (req, res) => {
    const userID = req.params.userID

    await UserContacts.aggregate([
        {
            $match:{
                $and:[
                    {
                        $or:[
                            { actionBy: userID },
                            { "users.userID": userID }
                        ]
                    },
                    {
                        status: true
                    }
                ]
            }
        },{
            $lookup:{
                from: "contacts",
                localField: "contactID",
                foreignField: "contactID",
                let: { 
                    firstUserID: { $arrayElemAt: ['$users.userID', 0] },
                    secondUserID: { $arrayElemAt: ['$users.userID', 1] } 
                },
                pipeline: [
                    {
                        $lookup:{
                            from: "useraccount",
                            pipeline:[
                                {
                                    $match: {
                                        $expr:{
                                            $and: [
                                                {$eq: ["$userID", "$$firstUserID"]},
                                                {$eq: ["$isVerified", true]},
                                                {$eq: ["$isActivated", true]}
                                            ]
                                        }
                                    }
                                }
                            ],
                            as: "userone"
                        }
                    },
                    {
                        $unwind:{
                            path: "$userone",
                            preserveNullAndEmptyArrays: true
                        }
                    },
                    {
                        $lookup:{
                            from: "useraccount",
                            pipeline:[
                                {
                                    $match: {
                                        $expr:{
                                            $and: [
                                                {$eq: ["$userID", "$$secondUserID"]},
                                                {$eq: ["$isVerified", true]},
                                                {$eq: ["$isActivated", true]}
                                            ]
                                        }
                                    }
                                }
                            ],
                            as: "usertwo"
                        }
                    },
                    {
                        $unwind:{
                            path: "$usertwo",
                            preserveNullAndEmptyArrays: true
                        }
                    }
                ],
                as: "userdetails"
            }
        },{
            $unwind:{
                path: "$userdetails",
                preserveNullAndEmptyArrays: true
            }
        },{
            $lookup:{
                from: "groups",
                localField: "contactID",
                foreignField: "groupID",
                as: "groupdetails"
            }
        },{
            $unwind:{
                path: "$groupdetails",
                preserveNullAndEmptyArrays: true
            }
        },{
            $project:{
                "userdetails.actionBy": 0,
                "userdetails.actionDate": 0,
                "userdetails.contactID": 0,
                "userdetails.status": 0,
                "userdetails.users": 0,
                "users": 0,
                "userdetails.userone.birthdate": 0,
                "userdetails.userone.dateCreated": 0,
                "userdetails.userone.email": 0,
                "userdetails.userone.gender": 0,
                "userdetails.userone.isActivated": 0,
                "userdetails.userone.isVerified": 0,
                "userdetails.userone.password": 0,
                "userdetails.usertwo.birthdate": 0,
                "userdetails.usertwo.dateCreated": 0,
                "userdetails.usertwo.email": 0,
                "userdetails.usertwo.gender": 0,
                "userdetails.usertwo.isActivated": 0,
                "userdetails.usertwo.isVerified": 0,
                "userdetails.usertwo.password": 0
            }
        },{
            $sort: {_id: -1}
        }
    ]).then((result) => {
        // console.log(result)
        const encodedResult = jwt.sign({
            contacts: result
        }, JWT_SECRET, {
            expiresIn: 60 * 60 * 24 * 7
        })

        res.send({ status: true, result: encodedResult })

    }).catch((err) => {
        console.log(err)
        res.send({ status: false, message: "Error fetching contacts list" })
    })
})

const checkExistingMessageID = async (messageID) => {
    return await UserMessage.find({ messageID: messageID }).then((result) => {
        if(result.length > 0){
            checkExistingMessageID(makeID(30))
        }
        else{
            return messageID
        }
    }).catch((err) => {
        console.log(err)
        return false;
    })
}

router.post('/sendMessage', jwtchecker, async (req, res) => {
    const userID = req.params.userID;
    const token = req.body.token;

    try{
        const decodedToken = jwt.verify(token, JWT_SECRET)

        const pendingID = decodedToken.pendingID;

        const messageID = await checkExistingMessageID(makeID(30));
        const conversationID = decodedToken.conversationID;
        const sender = userID;
        const receiversfetch = await GetAllReceivers(conversationID);
        const receivers = receiversfetch.users.map((mp) => mp.userID); //Array decodedToken.receivers
        const seeners = [
            userID
        ]; //Array
        const content = decodedToken.content;
        const messageDate = {
            date: dateGetter(),
            time: timeGetter()
        };
        const isReply = decodedToken.isReply;
        const replyingTo = decodedToken.replyingTo;
        const messageType = decodedToken.messageType;
        const conversationType = decodedToken.conversationType;

        const payload = {
            messageID: messageID,
            conversationID: conversationID,
            pendingID: pendingID,
            sender: sender,
            receivers: receivers,
            seeners: seeners,
            content: content,
            messageDate: messageDate,
            isReply: isReply,
            replyingTo: replyingTo,
            reactions: [],
            isDeleted: false,
            messageType: messageType,
            conversationType: conversationType
        }

        const newMessage = new UserMessage(payload)

        newMessage.save().then(async () => {
            res.send({status: true, message: "Message Sent", pendingID: pendingID})
            receivers.map((rcvs, i) => {
                MessagesTrigger(rcvs, sender, false)
            })
            await producer.publishMessage("INFO:CHATTERLOOP", MESSAGES_TRIGGER_LOOPER, {
                parameters: {
                    receivers: receivers,
                    sender: sender,
                    onseen: false
                }
            });
        }).catch((err) => {
            console.log(err)
            res.send({status: false, message: "Error checking message"})
        })

    }catch(ex){
        console.log(ex)
        res.send({status: false, message: "Failed to send message"})
    }

})

router.get('/initConversationList', jwtchecker, async (req, res) => {
    const userID = req.params.userID;

    await UserMessage.aggregate([
        {
            $match:{
                receivers: { $in: [userID] }
            }
        },{
            $group: {
                _id: "$conversationID",
                sortID: { "$last": "$_id" },
                conversationID: { "$last": "$conversationID" },
                messageID: { "$last": "$messageID" },
                conversationID: { "$last": "$conversationID" },
                sender: { "$last": "$sender" },
                receivers: { "$last": "$receivers" },
                seeners: { "$last": "$seeners" },
                content: { "$last": "$content" },
                messageDate: { "$last": "$messageDate" },
                isReply: { "$last": "$isReply" },
                replyingTo: { "$last": "$replyingTo" },
                reactions: { "$last": "$reactions" },
                isDeleted: { "$last": "$isDeleted" },
                messageType: { "$last": "$messageType" },
                conversationType: { "$last": "$conversationType" },
                unread: {
                    $sum: {
                        $cond: {
                            if:{
                                $in: [userID, "$seeners"]
                            },
                            then: 0,
                            else: 1
                        }
                    }
                }
            }
        },{
            $sort: {
                sortID: -1
            }
        },{
            $lookup:{
                from: "useraccount",
                localField: "receivers",
                foreignField: "userID",
                as: "users"
            }
        },{
            $lookup:{
                from: "groups",
                localField: "conversationID",
                foreignField: "groupID",
                as: "groupdetails"
            }
        },{
            $unwind:{
                path: "$groupdetails",
                preserveNullAndEmptyArrays: true
            }
        },{
            $lookup:{
                from: "servers",
                localField: "groupdetails.serverID",
                foreignField: "serverID",
                as: "serverdetails"
            }
        },{
            $unwind:{
                path: "$serverdetails",
                preserveNullAndEmptyArrays: true
            }
        },{
            $project:{
                "users.birthdate": 0,
                "users.dateCreated": 0,
                "users.email": 0,
                "users.gender": 0,
                "users.isActivated": 0,
                "users.isVerified": 0,
                "users.password": 0,
            }
        }
    ]).then((result) => {
        // console.log(result.reverse())
        const encodedResult = jwt.sign({
            conversationslist: result
        }, JWT_SECRET, {
            expiresIn: 60 * 60 * 24 * 7
        })

        res.send({status: true, message: "OK", result: encodedResult})
    }).catch((err) => {
        console.log(err)
        res.send({status: false, message: "Error generating conversations list"})
    })
})

router.get('/initConversation/:conversationID', jwtchecker, async (req, res) => {
    const userID = req.params.userID;
    const conversationID = req.params.conversationID;
    const range = req.headers["range"];
    const totalmessages = await GetAllMessageCountInAConversation(conversationID);

    await UserMessage.aggregate([ //find({ userID: profileUserID }).sort({ _id: -1 }).limit(range)
        {
            "$match": {
                conversationID: conversationID
            }
        },
        {
            "$lookup": {
                from: "messages",
                localField: "replyingTo",
                foreignField: "messageID",
                as: "replyedmessage"
            }
        },
        {
            "$lookup": {
                from: "useraccount",
                localField: "reactions.userID",
                foreignField: "userID",
                as: "reactionsWithInfo"
            }
        },
        {
            $project:{
                "reactionsWithInfo._id": 0,
                "reactionsWithInfo.birthdate": 0,
                "reactionsWithInfo.gender": 0,
                "reactionsWithInfo.email": 0,
                "reactionsWithInfo.password": 0,
                "reactionsWithInfo.dateCreated": 0
            }
        },
        {
            "$sort": {
                "_id": -1
            }
        },
        {
            "$limit": parseInt(range)
        }
    ]).then((result) => {
        var message = result.reverse();
        const encodedResult = jwt.sign({
            messages: message,
            total: totalmessages
        }, JWT_SECRET, {
            expiresIn: 60 * 60 * 24 * 7
        })

        res.send({ status: true, message: "OK", result: encodedResult })
    }).catch((err) => {
        console.log(err)
        res.send({ status: false, message: "Error generating conversation" })
    })
})

const sendMessageInitForGC = async (convID, userID, recs, message, type) => {
    const messageID = await checkExistingMessageID(makeID(30));
        const conversationID = convID;
        const sender = userID;
        const receivers = recs; //Array
        const seeners = []; //Array
        const content = `${userID} ${message}`;
        const messageDate = {
            date: dateGetter(),
            time: timeGetter()
        };
        const isReply = false;
        const messageType = "notif";
        const conversationType = type;

        const payload = {
            messageID: messageID,
            conversationID: conversationID,
            sender: sender,
            receivers: receivers,
            seeners: seeners,
            content: content,
            messageDate: messageDate,
            isReply: isReply,
            replyingTo: "",
            reactions: [],
            isDeleted: false,
            messageType: messageType,
            conversationType: conversationType
        }

        const newMessage = new UserMessage(payload)

        newMessage.save().then(async () => {
            receivers.map((rcvs, i) => {
                var sseWithUserID = sseNotificationsWaiters[rcvs]
                if(sseWithUserID){
                    MessagesTrigger(rcvs, sender, false)
                    ContactListTrigger(rcvs, `${userID} created a group chat`)
                }
            })
            await producer.publishMessage("INFO:CHATTERLOOP", MESSAGES_TRIGGER_LOOPER, {
                parameters: {
                    receivers: receivers,
                    sender: sender,
                    onseen: false
                }
            });
            await producer.publishMessage("INFO:CHATTERLOOP", CONTACT_LIST_TRIGGER_LOOPER, {
                parameters: {
                    receivers: receivers,
                    details: `${userID} created a group chat`
                }
            });
        }).catch((err) => {
            console.log(err)
        })
}

router.post('/createContactGroupChat', jwtchecker, async (req, res) => {
    const userID = req.params.userID
    const token = req.body.token;

    try{
        const decodeToken = jwt.verify(token, JWT_SECRET)

        const contactID = await checkContactID(`${makeID(20)}`)
        const otherUsers = decodeToken.otherUsers
        const groupName = decodeToken.groupName
        const privacy = decodeToken.privacy
        const allReceivers = [
            userID,
            ...otherUsers
        ]
        const userReceivers = allReceivers.map((alr, i) => ({
            userID: alr
        }))

        // console.log(allReceivers)

        const payload = {
            contactID: contactID,
            actionBy: userID,
            actionDate: {
                date: dateGetter(),
                time: timeGetter()
            },
            status: true,
            type: "group",
            users: userReceivers
        }

        const newContact = new UserContacts(payload)

        newContact.save().then(async () => {
            const groupParams = {
                groupID: contactID,
                groupName: groupName,
                profile: "",
                dateCreated: {
                    date: dateGetter(),
                    time: timeGetter()
                },
                createdBy: userID,
                privacy: privacy,
                type: "group"
            }

            const newGroup = new UserGroups(groupParams)
            newGroup.save().then(async () => {
                sendMessageInitForGC(contactID, userID, allReceivers, "created the group chat", "group")
                res.send({ status: true, message: `You created a Group Chat` })
            }).catch((err) => {
                res.send({ status: false, message: "Creating a group encountered an error!" })
                console.log(err)
            })

            // res.send({ status: true, message: `You created a Group Chat` })
        }).catch((err) => {
            res.send({ status: false, message: "Creating a group contact encountered an error!" })
            console.log(err)
        })
    }catch(ex){
        res.send({ status: false, message: "Group token encountered an error!" })
        console.log(ex)
    }
})

const creategroupchatreusable = async (serverID, channelName, userIDpass, tokenpass, privacyprop) => {
    const userID = userIDpass
    const token = tokenpass;

    try{
        const decodeToken = jwt.verify(token, JWT_SECRET)

        const contactID = await checkContactID(`${makeID(20)}`)
        const otherUsers = decodeToken.otherUsers
        const privacy = privacyprop
        const allReceivers = [
            userID,
            ...otherUsers
        ]
        const userReceivers = allReceivers.map((alr, i) => ({
            userID: alr
        }))

        // console.log(allReceivers)

        const payload = {
            contactID: contactID,
            actionBy: userID,
            actionDate: {
                date: dateGetter(),
                time: timeGetter()
            },
            status: privacy,
            type: "server",
            users: userReceivers
        }

        const newContact = new UserContacts(payload)

        newContact.save().then(async () => {
            const groupParams = {
                serverID: serverID,
                groupID: contactID,
                groupName: channelName,
                profile: "",
                dateCreated: {
                    date: dateGetter(),
                    time: timeGetter()
                },
                createdBy: userID,
                privacy: privacy,
                type: "server"
            }

            const newGroup = new UserGroups(groupParams)
            newGroup.save().then(async () => {
                sendMessageInitForGC(contactID, userID, allReceivers, "created the channel", "server")
            }).catch((err) => {
                console.log(err)
            })

            // res.send({ status: true, message: `You created a Group Chat` })
        }).catch((err) => {
            console.log(err)
        })
    }catch(ex){
        console.log(ex)
    }
}

router.post('/createchannel', jwtchecker, async (req, res) => {
    const userID = req.params.userID;
    const token = req.body.token;

    try{
        const decodedToken = jwt.verify(token, JWT_SECRET);
        const serverID = decodedToken.serverID;
        const memberstoadd = decodedToken.otherUsers;
        // const memberstoaddinserverdts = memberstoadd.map((mp) => ({ userID: mp }));
        const privacy = decodedToken.privacy;
        const groupName = decodedToken.groupName;
        
        const serverMembers = await GetServerMembers(serverID, false);

        if(privacy){
            const modifiedservermembers = memberstoadd;
            // console.log(privacy, modifiedservermembers);
            const channeltoken = jwt.sign({
                otherUsers: modifiedservermembers
            }, JWT_SECRET)
            creategroupchatreusable(serverID, groupName, userID, channeltoken, privacy);
        }
        else{
            const modifiedservermemberspub = serverMembers.filter((flt) => flt.userID !== userID).map((mp) => mp.userID);
            const channeltokenpub = jwt.sign({
                otherUsers: modifiedservermemberspub
            }, JWT_SECRET)
            // console.log(privacy, modifiedservermemberspub, jwt.verify(channeltokenpub, JWT_SECRET))
            creategroupchatreusable(serverID, groupName, userID, channeltokenpub, privacy);
        }

        res.send({ status: true, message: "OK" });
    }catch(ex){
        console.log(ex);
        res.send({ status: false, message: "Error decoding token" })
    }
})

router.post('/createserver', jwtchecker, async (req, res) => {
    const userID = req.params.userID
    const token = req.body.token;

    try{
        const decodeToken = jwt.verify(token, JWT_SECRET);
        const defaultchannellist = ["General", "Announcements", "Random"];

        const serverID = await checkServerID(`${makeID(20)}`)
        const otherUsers = decodeToken.otherUsers
        const serverName = decodeToken.groupName
        const privacy = decodeToken.privacy
        const allReceivers = [
            userID,
            ...otherUsers
        ]
        const userReceivers = allReceivers.map((alr, i) => ({
            userID: alr
        }))

        // console.log(allReceivers)

        const payload = {
            serverID: serverID,
            serverName: serverName,
            profile: "",
            dateCreated: {
                date: dateGetter(),
                time: timeGetter()
            },
            members: userReceivers,
            createdBy: userID,
            privacy: privacy
        }

        const newserver = new UserServers(payload);
        newserver.save().then(async () => {
            defaultchannellist.map((mp) => {
                creategroupchatreusable(serverID, mp, userID, token, false);
            })
            res.send({ status: true, message: `You created a Group Chat` })
        }).catch((err) => {
            res.send({ status: false, message: "Creating a server encountered an error!" })
            console.log(err)
        })
    }catch(ex){
        res.send({ status: false, message: "Group token encountered an error!" })
        console.log(ex)
    }
})

router.post('/seenNewMessages', jwtchecker, async (req, res) => {
    const userID = req.params.userID
    const token = req.body.token;
    const range = req.headers["range"];

    // console.log("Seen", range);

    try{
        const decodeToken = jwt.verify(token, JWT_SECRET)

        const conversationID = decodeToken.conversationID;
        const receiversfetch = await GetAllReceivers(conversationID);
        const receivers = receiversfetch.users.map((mp) => mp.userID); //Array decodedToken.receivers
        // const receivers = decodeToken.receivers;

        // console.log(receivers)
        
        UserMessage.updateMany({ 
            conversationID: conversationID,
            seeners: {
                $nin: [userID]
            } 
        },{
            $push: {
                seeners: userID
            }
        }).then(async (result) => {
            // console.log(result.modifiedCount)
            if(result.modifiedCount > 0){
                receivers.map((rcvs, i) => {
                    MessagesTrigger(rcvs, userID, true)
                })
                await producer.publishMessage("INFO:CHATTERLOOP", MESSAGES_TRIGGER_LOOPER, {
                    parameters: {
                        receivers: receivers,
                        sender: userID,
                        onseen: true
                    }
                });
            }
            res.send({ status: true, message: "Seen OK" });
        }).catch((err) => {
            console.log(err)
            res.send({ status: false, message: "Cannot update seen status" })
        })
    }catch(ex){
        console.log(ex)
        res.send({ status: false, message: "Error reading messages!" })
    }
})

const checkExistingFileID = async (checkID) => {
    return await UploadedFiles.find({ fileID: checkID}).then((result) => {
        if(result.length > 0){
            checkExistingFileID(`FILE_${makeID(20)}`)
        }
        else{
            return checkID;
        }
    }).catch((err) => {
        console.log(err)
        return false;
    })
}

const saveFileRecordToDatabase = async (foreignID, fileData, action, fileType, fileOrigin) => {
    const payload = {
        fileID: await checkExistingFileID(`FILE_${makeID(20)}`),
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

const uploadFirebase = async (mp, userID, receivers, isReply, replyingTo, conversationType) => {
    var messageID = await checkExistingMessageID(makeID(30))

    var arr = mp.content.split(',')
    var fileTypeBase = arr[0].match(/:(.*?);/)[1]
    var fileType = arr[0].match(/:(.*?);/)[1].split("/")[1]

    var fileIDTypeChecker = !mp.type.includes("audio") && !mp.type.includes("video") && !mp.type.includes("image") ? "" : `.${fileType}`
    let tosplitname = mp.name ? mp.name : ""
    let split = tosplitname.split(".");
    let splicedStr = split.slice(0, split.length - 1).join(".")
    var fileNameChecker = mp.name ? `${splicedStr}###` : 'IMG_'
    var fileNameCheckerEncoded = mp.name ? `${encodeURIComponent(splicedStr)}###` : 'IMG_'
    var fileIDRandomStamp = makeID(20);
    var fileID = `${fileNameChecker}${fileIDRandomStamp}${fileIDTypeChecker}`
    var fileIDEncoded = `${fileNameCheckerEncoded}${fileIDRandomStamp}${fileIDTypeChecker}`
    var fileIDwoType = `IMG_${makeID(20)}`
    // var fileFinal = dataURLtoFile(mp.content, fileIDwoType)
    var contentFinal = mp.content.split('base64,')[1]
    var fileFinal = base64ToArrayBuffer(contentFinal)
    var finalBuffer = Buffer.from(fileFinal)

    const folderDesignation = {
        image: 'imgs',
        video: 'videos',
        audio: 'audios',
        any: 'files'
    }

    var fileTypeChecker = !mp.type.includes("audio") && !mp.type.includes("video") && !mp.type.includes("image") ? folderDesignation["any"] : folderDesignation[mp.type.split("/")[0]] 
    var finalPathwithID = `${fileTypeChecker}/${fileID}`
    var finalPathwithIDEncoded = `${fileTypeChecker}/${fileIDEncoded}`

    // console.log(finalPathwithID)

    const file = storage.bucket().file(finalPathwithID)

    await file.save(finalBuffer, {
        contentType: fileTypeBase,
        public: true
    }).then((url) => {
        const publicUrl = mp.type.includes("image") ? `https://storage.googleapis.com/${FIREBASE_STORAGE_BUCKET}/${finalPathwithID}` : `https://storage.googleapis.com/${FIREBASE_STORAGE_BUCKET}/${finalPathwithIDEncoded}%%%${mp.name}`;
        saveFileMessage(userID, messageID, mp.pendingID, mp.conversationID, receivers, publicUrl, isReply, replyingTo, mp.type, conversationType)
    })
}

const saveFileMessage = async (userID, messageID, pendingID, conversationID, receivers, content, isReply, replyingTo, messageType, conversationType) => {
    const seeners = [
        userID
    ]; //Array
    const messageDate = {
        date: dateGetter(),
        time: timeGetter()
    };
    
    const payload = {
        messageID: messageID,
        conversationID: conversationID,
        pendingID: pendingID,
        sender: userID,
        receivers: receivers,
        seeners: seeners,
        content: content,
        messageDate: messageDate,
        isReply: isReply,
        replyingTo: replyingTo,
        reactions: [],
        isDeleted: false,
        messageType: messageType,
        conversationType: conversationType
    }
    
    const newMessage = new UserMessage(payload)
    
    newMessage.save().then(async () => {
        saveFileRecordToDatabase([messageID, conversationID], content, "message", messageType, "firebase")
        receivers.map((rcvs, i) => {
            MessagesTrigger(rcvs, userID, false)
        })
        await producer.publishMessage("INFO:CHATTERLOOP", MESSAGES_TRIGGER_LOOPER, {
            parameters: {
                receivers: receivers,
                sender: userID,
                onseen: false
            }
        });
    }).catch((err) => {
        console.log(err)
    })
}

router.post('/sendFiles', jwtchecker, async (req, res) => {
    const userID = req.params.userID
    const token = req.body.token;

    try{
        const decodeToken = jwt.verify(token, JWT_SECRET)

        const conversationID = decodeToken.conversationID
        const receiversfetch = await GetAllReceivers(conversationID);
        const receivers = receiversfetch.users.map((mp) => mp.userID); //Array decodedToken.receivers
        // const receivers = decodeToken.receivers;
        const files = decodeToken.files;
        const isReply = decodeToken.isReply;
        const replyingTo = decodeToken.replyingTo;
        const conversationType = decodeToken.conversationType;

        files.map((mp) => {
           uploadFirebase(mp, userID, receivers, isReply, replyingTo, conversationType)
        })

        res.send({ status: true, message: "OK" })
    }catch(ex){
        console.log(ex)
        res.send({ status: false, message: "Error decoding files!" })
    }
})

router.post('/call', jwtchecker, async (req, res) => {
    const userID = req.params.userID
    const token = req.body.token;

    try{
        const decodeToken = jwt.verify(token, JWT_SECRET)
        const recepients = decodeToken.recepients;
        
        recepients.map((rcp) => {
            ReachCallRecepients(rcp, decodeToken)
        })
        await producer.publishMessage("INFO:CHATTERLOOP", REACH_CALL_RECEPIENTS_LOOPER, {
            parameters: {
                recepients: recepients,
                decodedToken: decodeToken
            }
        });

        res.send({ status: true, message: "OK" })
    }catch(ex){
        console.log(ex)
        res.send({ status: false, message: "Error declaring call!" })
    }
})

const getContactsForSession = async (userID) => {
    return await UserContacts.aggregate([
        {
            $match:{
                $and:[
                    {
                        $or:[
                            { actionBy: userID },
                            { "users.userID": userID }
                        ]
                    },
                    {
                        status: true
                    },
                    {
                        type: "single"
                    }
                ]
            }
        },{
            $lookup:{
                from: "contacts",
                localField: "contactID",
                foreignField: "contactID",
                let: { 
                    firstUserID: { $arrayElemAt: ['$users.userID', 0] },
                    secondUserID: { $arrayElemAt: ['$users.userID', 1] } 
                },
                pipeline: [
                    {
                        $lookup:{
                            from: "useraccount",
                            pipeline:[
                                {
                                    $match: {
                                        $expr:{
                                            $and: [
                                                {$eq: ["$userID", "$$firstUserID"]},
                                                {$eq: ["$isVerified", true]},
                                                {$eq: ["$isActivated", true]}
                                            ]
                                        }
                                    }
                                }
                            ],
                            as: "userone"
                        }
                    },
                    {
                        $unwind:{
                            path: "$userone",
                            preserveNullAndEmptyArrays: true
                        }
                    },
                    {
                        $lookup:{
                            from: "useraccount",
                            pipeline:[
                                {
                                    $match: {
                                        $expr:{
                                            $and: [
                                                {$eq: ["$userID", "$$secondUserID"]},
                                                {$eq: ["$isVerified", true]},
                                                {$eq: ["$isActivated", true]}
                                            ]
                                        }
                                    }
                                }
                            ],
                            as: "usertwo"
                        }
                    },
                    {
                        $unwind:{
                            path: "$usertwo",
                            preserveNullAndEmptyArrays: true
                        }
                    }
                ],
                as: "userdetails"
            }
        },{
            $unwind:{
                path: "$userdetails",
                preserveNullAndEmptyArrays: true
            }
        },{
            $lookup:{
                from: "groups",
                localField: "contactID",
                foreignField: "groupID",
                as: "groupdetails"
            }
        },{
            $unwind:{
                path: "$groupdetails",
                preserveNullAndEmptyArrays: true
            }
        },{
            $project:{
                "userdetails.actionBy": 0,
                "userdetails.actionDate": 0,
                "userdetails.contactID": 0,
                "userdetails.status": 0,
                "userdetails.users": 0,
                "users": 0,
                "userdetails.userone.birthdate": 0,
                "userdetails.userone.dateCreated": 0,
                "userdetails.userone.email": 0,
                "userdetails.userone.gender": 0,
                "userdetails.userone.isActivated": 0,
                "userdetails.userone.isVerified": 0,
                "userdetails.userone.password": 0,
                "userdetails.usertwo.birthdate": 0,
                "userdetails.usertwo.dateCreated": 0,
                "userdetails.usertwo.email": 0,
                "userdetails.usertwo.gender": 0,
                "userdetails.usertwo.isActivated": 0,
                "userdetails.usertwo.isVerified": 0,
                "userdetails.usertwo.password": 0
            }
        },{
            $sort: {_id: -1}
        }
    ]).then((result) => {
        return result.map((mp) => {
            if(mp.userdetails.userone.userID == userID){
                return mp.userdetails.usertwo.userID;
            }
            else{
                return mp.userdetails.userone.userID;
            }
        });
    }).catch((err) => {
        console.log(err)
        return [];
    })
}

const checkSessionID = async (currentID) => {
    return await UserSessions.find({ sessionID: currentID }).then((result) => {
        if(result.length > 0){
            checkSessionID(`SESSION_${makeID(20)}_${timeGetter()}_${dateGetter()}`.split(" ").join("").split(":").join("_").split("pm").join("_").split("/").join("_"));
        }
        else{
            return currentID;
        }
    }).catch((err) => {
        console.log(err);
        return false;
    })
}

const setUserSession = async (userID, status, resolve) => {
    const newSessionID = await checkSessionID(`SESSION_${makeID(20)}_${timeGetter()}_${dateGetter()}`.split(" ").join("").split(":").join("_").split("pm").join("_").split("/").join("_"));
    const newSessionPayload = {
        sessionID: newSessionID,
        userID: userID,
        sessionStatus: status,
        sessiondate: {
            date: dateGetter(),
            time: timeGetter()
        }
    }

    await UserSessions.find({ userID: userID }).then((result) => {
        if(result.length > 0){
            UserSessions.updateMany({ userID: userID }, newSessionPayload).then((_) => {
                resolve();
            }).catch((err) => {
                console.log(err);
            })
        }
        else{
            const newSession = new UserSessions(newSessionPayload);

            newSession.save().then(() => {
                resolve()
            }).catch((err) => {
                console.log(err);
            })
        }
    }).catch((err) => {
        console.log(err);
    })
}

router.get('/sseNotifications/:token', [sse, jwtssechecker], async (req, res) => {
    const userID = req.params.userID
    const sseWithUserID = sseNotificationsWaiters[userID]
    const contacts = await getContactsForSession(userID);
    const sessionstamp = `SESSION_STAMP_${makeid(15)}`

    if(sseWithUserID){
        sseNotificationsWaiters[userID] = {
            response: [
                ...sseWithUserID.response,
                {
                    sessionstamp: sessionstamp,
                    res: res
                }
            ]
        }
    }
    else{
        sseNotificationsWaiters[userID] = {
            response: [
                {
                    sessionstamp: sessionstamp,
                    res: res
                }
            ]
        }
    }

    const activeMetaData = {
        _id: userID,
        sessionStatus: true,
        sessiondate: {
            date: dateGetter(),
            time: timeGetter()
        }
    }

    setUserSession(userID, true, async () => {
        // console.log("CONNECTED", userID);
        contacts.map((mp) => {
            UpdateContactswSessionStatus(mp, activeMetaData)
        })
        await producer.publishMessage("INFO:CHATTERLOOP", UPDATE_CONTATCS_W_SESSION_STATUS_LOOPER, {
            parameters: {
                contacts: contacts,
                decodedToken: activeMetaData
            }
        });
    })
    
    req.on('close', () => {
        const disconnectMetaData = {
            _id: userID,
            sessionStatus: false,
            sessiondate: {
                date: dateGetter(),
                time: timeGetter()
            }
        }

        setUserSession(userID, false, async () => {
            // console.log("DISCONNECTED", userID);
            clearASingleSession(userID, sessionstamp);
            contacts.map((mp) => {
                UpdateContactswSessionStatus(mp, disconnectMetaData)
            })
            await producer.publishMessage("INFO:CHATTERLOOP", UPDATE_CONTATCS_W_SESSION_STATUS_LOOPER, {
                parameters: {
                    contacts: contacts,
                    decodedToken: disconnectMetaData
                }
            });
        })
    })
})

router.get('/activecontacts', jwtchecker, async (req, res) => {
    const userID = req.params.userID
    const contacts = await getContactsForSession(userID);

    // console.log(contacts)

    await UserSessions.aggregate([
        {
            $match: {
                 userID: { $in: contacts }
            }
        },{
            $group: {
                "_id": "$userID",
                "sessionID": { 
                    "$last": "$sessionID"
                 },
                "sessionStatus": { 
                    "$last": "$sessionStatus"
                 },
                "sessiondate": { 
                    "$last": "$sessiondate"
                 }
            }
        }
    ]).then((result) => {
        const resultChecker = result.map((mp) => mp._id)
        const sessionFiller = contacts.map((mp) => {
            if(resultChecker.includes(mp)){
                return(result.filter((flt) => flt._id == mp)[0])
            }
            else{
                return {
                    _id: mp,
                    sessionStatus: false,
                    sessiondate: null
                }
            }
        })
        res.send({ status: true, result: sessionFiller })
    }).catch((err) => {
        console.log(err);
        res.send({ status: false, message: "Error getting active users" })
    })
})

router.post('/rejectcall', jwtchecker, async (req, res) => {
    const userID = req.params.userID;
    const token = req.body.token;

    try{
        const decodeToken = jwt.verify(token, JWT_SECRET)
        const conversationID = decodeToken.conversationID;
        const conversationType = decodeToken.conversationType;
        const callerID = decodeToken.caller.userID;

        if(conversationType == "single"){
            CallRejectNotif(callerID, {
                conversationID: conversationID,
                rejectedBy: userID
            })
            await producer.publishMessage("INFO:CHATTERLOOP", CALL_REJECT_NOTIF, {
                parameters: {
                    rcp: callerID,
                    decodeToken: {
                        conversationID: conversationID,
                        rejectedBy: userID
                    }
                }
            });
        }

        res.send({ status: true, message: "OK" })
    }
    catch(ex){
        console.log(ex)
        res.send({ status: false, message: "Cannot decode token" })
    }
})

router.post('/endcall', jwtchecker, async (req, res) => {
    const userID = req.params.userID;
    const token = req.body.token;

    try{
        const decodeToken = jwt.verify(token, JWT_SECRET)
        const conversationID = decodeToken.conversationID;
        const conversationType = decodeToken.conversationType;
        const recepients = decodeToken.recepients;

        recepients.map((mp) => {
            CallRejectNotif(mp, {
                conversationID: conversationID,
                endedBy: userID
            })
        })
        await producer.publishMessage("INFO:CHATTERLOOP", CALL_REJECT_NOTIF_LOOPER, {
            parameters: {
                recepients: recepients,
                decodeToken: {
                    conversationID: conversationID,
                    endedBy: userID
                }
            }
        });

        res.send({ status: true, message: "OK" })
    }
    catch(ex){
        console.log(ex)
        res.send({ status: false, message: "Cannot decode token" })
    }
})

router.get('/sselogout', jwtchecker, (req, res) => {
    
})

module.exports = router;

