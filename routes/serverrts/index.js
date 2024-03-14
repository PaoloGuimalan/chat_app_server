require("dotenv").config()
const express = require("express")
const jwt = require("jsonwebtoken")
const { sseNotificationsWaiters } = require("../../reusables/hooks/sse")
const dateGetter = require("../../reusables/hooks/getDate")
const timeGetter = require("../../reusables/hooks/getTime")
const makeID = require("../../reusables/hooks/makeID")
const { jwtchecker, createJWT } = require("../../reusables/hooks/jwthelper")
const router = express.Router();

const UserServer = require("../../schema/users/servers")
const UserMessage = require("../../schema/messages/message")

const JWT_SECRET = process.env.JWT_SECRET

router.get('/initserverlist', jwtchecker, (req, res) => {
    const userID = req.params.userID;

    UserServer.find({ members: { $in: [{ userID: userID }] } }).then((result) => {
        const encodedResult = createJWT(result)
        res.send({ status: true, result: encodedResult })
    }).catch((err) => {
        console.log(err);
        res.send({ status: false, message: "Error fetching server list" })
    })
})

router.get('/initserversetup/:conversationID', jwtchecker, async (req, res) => {
    const userID = req.params.userID;
    const conversationID = req.params.conversationID;

    await UserMessage.aggregate([
        {
            $match:{
                $and: [
                    {receivers: { $in: [userID] }},
                    {conversationID: conversationID}
                ]
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
        // console.log(result)
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

router.get('/initserverchannels/:serverID', jwtchecker, async (req, res) => {
    const userID = req.params.userID;
    const serverID = req.params.serverID;

    await UserServer.aggregate([
        {
            $match: { 
                $and:[
                    { serverID: serverID },
                    { members: { $in: [{ userID: userID }] } }
                ]
            }
        },{
            $lookup:{
                from: "groups",
                localField: "serverID",
                foreignField: "serverID", //from groups
                pipeline: [{
                    $lookup:{
                        from: "messages",
                        localField: "groupID",
                        foreignField: "conversationID",
                        pipeline: [{
                            $match: { seeners: { $nin: [userID] }}
                        },{
                            $count: "unread"
                        }],
                        as: "messages"
                    }
                }],
                as: "channels"
            }
        }
    ]).then((result) => {
        const encodedResult = createJWT({
            data: result
        })
        res.send({ status: true, result: encodedResult });
    }).catch((err) => {
        console.log(err);
        res.send({ status: false, message: "Error fetching server" });
    })
})

module.exports = router;