let sseNotificationsWaiters = Object.create(null);

const UserNotifications = require("../../schema/users/notifications");
const UserMessage = require("../../schema/messages/message");
const UserContacts = require("../../schema/users/contacts");
const { createJWTwExp } = require("./jwthelper");
const { CountAllUnreadNotifications } = require("../models/notifications");

const SendTagPostNotification = async (details, userID) => {
    const sseWithUserID = sseNotificationsWaiters[userID];
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
        var encodedResult = createJWTwExp({
            notifications: result,
            totalunread: UnreadNotificationsTotal
        });

        if(sseWithUserID){
            // console.log(sseWithUserID)
            sseWithUserID.response.map((itr, i) => {
                itr.res.sse(`notifications`, {
                    status: true,
                    auth: true,
                    message: details,
                    result: encodedResult
                })
            })
        }
    }).catch((err) => {
        console.log(err)
        if(sseWithUserID){
            sseWithUserID.response.map((itr, i) => {
                itr.res.sse(`notifications`, {
                    status: false,
                    auth: true,
                    message: "Error retrieving notifications"
                })
            })
        }
    })
}

const ContactListTrigger = async (id, details) => {
    const userID = id;
    const sseWithUserID = sseNotificationsWaiters[userID];

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
        const encodedResult = createJWTwExp({
            contacts: result
        })

        if(sseWithUserID){
            sseWithUserID.response.map((itr, i) => {
                itr.res.sse(`contactslist`, {
                    status: true,
                    auth: true,
                    message: details,
                    result: encodedResult
                })
            })
        }

        // res.send({ status: true, result: encodedResult })

    }).catch((err) => {
        console.log(err)
        if(sseWithUserID){
            sseWithUserID.response.map((itr, i) => {
                itr.res.sse(`contactslist`, {
                    status: false,
                    auth: true,
                    message: "Error fetching contacts list"
                })
            })
        }

        // res.send({ status: false, message: "Error fetching contacts list" })
    })
}

const MessagesTrigger = async (id, details, onseen) => {
    const userID = id;
    const sseWithUserID = sseNotificationsWaiters[userID];

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
                "users.password": 0
            }
        }
    ]).then((result) => {
        // console.log(result)
        const encodedResult = createJWTwExp({
            conversationslist: result
        })

        if(sseWithUserID){
            sseWithUserID.response.map((itr, i) => {
                itr.res.sse(`messages_list`, {
                    status: true,
                    auth: true,
                    onseen: onseen,
                    message: details,
                    result: encodedResult
                })
            })
        }
    }).catch((err) => {
        console.log(err)
        if(sseWithUserID){
            sseWithUserID.response.map((itr, i) => {
                itr.res.sse(`messages_list`, {
                    status: false,
                    auth: true,
                    message: "Error generating conversations list"
                })
            })
        }
    })
}

const ReloadUserNotification = async (id, details) => {
    const userID = id;
    const sseWithUserID = sseNotificationsWaiters[userID];
    const UnreadNotificationsTotal =  await CountAllUnreadNotifications(id);

    await UserNotifications.aggregate([
        {
            $match:{
                toUserID: id
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
        var encodedResult = createJWTwExp({
            notifications: result,
            totalunread: UnreadNotificationsTotal
        })

        if(sseWithUserID){
            sseWithUserID.response.map((itr, i) => {
                itr.res.sse(`notifications_reload`, {
                    status: true,
                    auth: true,
                    message: details,
                    result: encodedResult
                })
            })
        }
    }).catch((err) => {
        console.log(err)
        if(sseWithUserID){
            sseWithUserID.response.map((itr, i) => {
                itr.res.sse(`notifications_reload`, {
                    status: false,
                    auth: true,
                    message: "Error retrieving notifications"
                })
            })
        }
    })
}

const BroadcastIsTypingStatus = (receiver, data) => {
    const sseWithUserID = sseNotificationsWaiters[receiver];

    var encodedResult = createJWTwExp({
        istyping: data
    })

    if(sseWithUserID){
        sseWithUserID.response.map((itr, i) => {
            itr.res.sse(`istyping_broadcast`, {
                status: true,
                auth: true,
                message: "istyping broadcast",
                result: encodedResult
            })
        })
    }
}

const clearASingleSession = (tokenfromsse, sessionstamp) => {
    const connectionID = tokenfromsse;
    const ifexistingsession = sseNotificationsWaiters[connectionID];

    if(ifexistingsession){
        const minusmutatesession = ifexistingsession.response.filter((flt) => flt.sessionstamp != sessionstamp);
        
        if(minusmutatesession.length > 0){
            sseNotificationsWaiters[connectionID] = {
                response: minusmutatesession
            }
        }
        else{
            delete sseNotificationsWaiters[connectionID];
        }
    }
}

const clearAllSession = () => {
    sseNotificationsWaiters = Object.create(null);
}

module.exports = {
    sseNotificationsWaiters,
    SendTagPostNotification,
    MessagesTrigger,
    ContactListTrigger,
    ReloadUserNotification,
    BroadcastIsTypingStatus,
    clearASingleSession,
    clearAllSession
}