let sseNotificationsWaiters = Object.create(null);

const UserNotifications = require("../../schema/users/notifications");
const UserMessage = require("../../schema/messages/message");
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
    ReloadUserNotification,
    BroadcastIsTypingStatus,
    clearASingleSession,
    clearAllSession
}