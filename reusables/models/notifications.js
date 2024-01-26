const UserNotifications = require("../../schema/users/notifications");

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

module.exports = {
    checkNotifID
}