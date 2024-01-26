let sseNotificationsWaiters = Object.create(null);

const UserNotifications = require("../../schema/users/notifications");
const { createJWTwExp } = require("./jwthelper");

const SendTagPostNotification = async (details, userID) => {
    const sseWithUserID = sseNotificationsWaiters[userID];

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
            notifications: result
        });

        if(sseWithUserID){
            // console.log(sseWithUserID)
            sseWithUserID.response.map((itr, i) => {
                itr.sse(`notifications`, {
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
                itr.sse(`notifications`, {
                    status: false,
                    auth: true,
                    message: "Error retrieving notifications"
                })
            })
        }
    })
}

module.exports = {
    sseNotificationsWaiters,
    SendTagPostNotification
}