require("dotenv").config()
const express = require("express")
const router = express.Router()
const mongoose = require("mongoose")
const jwt = require("jsonwebtoken")
const Axios = require("axios")

const UserAccount = require("../../schema/auth/useraccount")
const UserVerification = require("../../schema/auth/userverification")
const UploadedFiles = require("../../schema/posts/uploadedfiles")
const UserContacts = require("../../schema/users/contacts")
const UserMessage = require('../../schema/messages/message')
const { jwtchecker, createJWT } = require("../../reusables/hooks/jwthelper")
const { GetMessageReceivers, AddNewMemberToAllMessages, AddNewMemberToContacts, NotificationMessageForConversations, GetAllReceivers } = require("../../reusables/models/messages")
const { MessagesTrigger, BroadcastIsTypingStatus } = require("../../reusables/hooks/sse")
const { MESSAGES_TRIGGER_LOOPER, BROADCAST_IS_TYPING_STATUS_LOOPER } = require("../../reusables/vars/rabbitmqevents")
const producer = require("../../reusables/rabbitmq/producer")

const MAILINGSERVICE_DOMAIN = process.env.MAILINGSERVICE
const JWT_SECRET = process.env.JWT_SECRET

const ssexpresssample = (req, res, next) => {
    console.log("SSE SAMPLE MIDDLEWARE")
    next()
}

router.get('/getMessages', [jwtchecker, ssexpresssample], (req, res) => {
    res.send({status: true, message: "getMessages Testing endpoint"})
})

router.post('/deletemessage', jwtchecker, (req, res) => {
    const token = req.body.token;
    const userID = req.params.userID;

    try{
        const decodedToken = jwt.verify(token, JWT_SECRET);

        // console.log(decodedToken);

        UserMessage.updateOne({ conversationID: decodedToken.conversationID, messageID: decodedToken.messageID }, { isDeleted: true }).then( async (result) => {
            const messageReceivers = await GetMessageReceivers(decodedToken.conversationID, decodedToken.messageID);
            
            messageReceivers.map((user) => {
                MessagesTrigger(user, userID, false);
            })

            await producer.publishMessage("INFO:CHATTERLOOP", MESSAGES_TRIGGER_LOOPER, {
                parameters: {
                    receivers: messageReceivers,
                    sender: userID,
                    onseen: false
                }
            });

            res.send({ status: true, message: "OK" })
        }).catch((err) => {
            res.send({ status: false, message: err.message })
        })
    }catch(ex){
        console.log(ex);
        res.send({ status: false, message: "Error decoding token" })
    }
})

router.post('/addreaction', jwtchecker, (req, res) => {
    const token = req.body.token;
    const userID = req.params.userID;

    try{
        const decodedToken = jwt.verify(token, JWT_SECRET);

        // console.log(decodedToken);

        UserMessage.updateOne({ conversationID: decodedToken.conversationID, messageID: decodedToken.messageID }, { $push: { reactions: decodedToken.newreaction } }).then( async (result) => {
            const messageReceivers = await GetMessageReceivers(decodedToken.conversationID, decodedToken.messageID);
            
            messageReceivers.map((user) => {
                MessagesTrigger(user, userID, false);
            })

            await producer.publishMessage("INFO:CHATTERLOOP", MESSAGES_TRIGGER_LOOPER, {
                parameters: {
                    receivers: messageReceivers,
                    sender: userID,
                    onseen: false
                }
            });

            res.send({ status: true, message: "OK" })
        }).catch((err) => {
            res.send({ status: false, message: err.message })
        })
    }catch(ex){
        console.log(ex);
        res.send({ status: false, message: "Error decoding token" })
    }
})

router.get('/conversationinfo/:conversationID/:type', jwtchecker, (req, res) => {
    const userID = req.params.userID;
    const conversationID = req.params.conversationID;
    const type = req.params.type;

    if(type === "single"){
        UserContacts.aggregate([
            {
                $match: {
                    contactID: conversationID
                }
            },
            {
                $lookup: {
                    from: "useraccount",
                    localField: "users.userID",
                    foreignField: "userID",
                    as: "usersWithInfo"
                }
            },
            {
                $lookup: {
                    from: "files",
                    localField: "contactID",
                    foreignField: "foreignID",
                    as: "conversationfiles"
                }
            },
            {
                $project: {
                    "usersWithInfo.birthdate": 0,
                    "usersWithInfo.dateCreated": 0,
                    "usersWithInfo.email": 0,
                    "usersWithInfo.gender": 0,
                    "usersWithInfo.password": 0,
                    "usersWithInfo.coverphoto": 0
                }
            }
        ]).then((result) => {
            if(result.length > 0) {
                var flattenedResults = result[0];
                const encodedResult = createJWT({
                    data: flattenedResults
                })
                res.send({ status: true, result: encodedResult })
            }
            else{
                // respond as no records
                res.send({ status: false, message: "No conversation details matched" })
            }
        }).catch((err) => {
            console.log(err);
            res.send({ status: false, message: "Cannot determine conversation details" })
        })
    }
    else{
        UserContacts.aggregate([
            {
                $match: {
                    contactID: conversationID
                }
            },
            {
                $lookup: {
                    from: "groups",
                    localField: "contactID",
                    foreignField: "groupID",
                    as: "conversationInfo"
                }
            },
            {
                $unwind: "$conversationInfo"
            },
            {
                $lookup: {
                    from: "useraccount",
                    localField: "users.userID",
                    foreignField: "userID",
                    as: "usersWithInfo"
                }
            },
            {
                $lookup: {
                    from: "files",
                    localField: "contactID",
                    foreignField: "foreignID",
                    as: "conversationfiles"
                }
            },
            {
                $project: {
                    "usersWithInfo.birthdate": 0,
                    "usersWithInfo.dateCreated": 0,
                    "usersWithInfo.email": 0,
                    "usersWithInfo.gender": 0,
                    "usersWithInfo.password": 0,
                    "usersWithInfo.coverphoto": 0
                }
            }
        ]).then((result) => {
            if(result.length > 0) {
                var flattenedResults = result[0];
                const encodedResult = createJWT({
                    data: flattenedResults
                })
                res.send({ status: true, result: encodedResult })
            }
            else{
                // respond as no records
                res.send({ status: false, message: "No conversation details matched" })
            }
        }).catch((err) => {
            console.log(err);
            res.send({ status: false, message: "Cannot determine conversation details" })
        })
    }
})

router.post('/istypingbroadcast', jwtchecker, async (req, res) => {
    const token = req.body.token;
    const userID = req.params.userID;

    try{
        const decodedToken = jwt.verify(token, JWT_SECRET);
        const receiversfetch = await GetAllReceivers(decodedToken.conversationID);
        const receivers = receiversfetch.users.map((mp) => mp.userID); //Array decodedToken.receivers
        // const receivers = decodedToken.receivers;

        receivers.map((mp) => {
            if(mp !== userID){
                BroadcastIsTypingStatus(mp, { userID: userID, conversationID: decodedToken.conversationID });
            }
        })

        await producer.publishMessage("INFO:CHATTERLOOP", BROADCAST_IS_TYPING_STATUS_LOOPER, {
            parameters: {
                receivers: receivers.filter((flt) => flt !== userID),
                data: { userID: userID, conversationID: decodedToken.conversationID }
            }
        });

        // console.log(userID, decodedToken.conversationID, decodedToken.receivers);

        res.send({ status: true, message: "OK" })
    }catch(ex){
        console.log(ex);
        res.send({ status: false, message: "Error decoding token" })
    }
})

router.post('/addnewmember', jwtchecker, async (req, res) => {
    const token = req.body.token;
    const userID = req.params.userID;

    try{
        const decodedToken = jwt.verify(token, JWT_SECRET);
        const conversationID = decodedToken.conversationID;
        const memberstoadd = decodedToken.memberstoadd;
        const receiversfetch = await GetAllReceivers(conversationID);
        const receivers = [...decodedToken.receivers, ...receiversfetch.users.map((mp) => mp.userID)];

        memberstoadd.map((mp) => {
            AddNewMemberToContacts(conversationID, mp.userID).then(() => {
                AddNewMemberToAllMessages(conversationID, mp.userID).then(() => {
                    NotificationMessageForConversations(conversationID, userID, receivers, `${userID} added ${mp.userID}`, "group")
                }).catch((err) => console.log);
            }).catch((err) => console.log);
        })

        // console.log(userID, decodedToken.conversationID, decodedToken.memberstoadd);

        res.send({ status: true, message: "OK" })
    }catch(ex){
        console.log(ex);
        res.send({ status: false, message: "Error decoding token" })
    }
})

module.exports = router;

