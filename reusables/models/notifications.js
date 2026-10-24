const UserNotifications = require("../../schema/users/notifications");
const pool = require("../database/postgres");
const { notificationAudienceMatch } = require("./communityNotifications");
const makeID = require("../hooks/makeID");

const checkNotifID = async (ntfID) => {
  return await UserNotifications.find({ notificationID: ntfID }).then((result) => {
    if (result.length) {
      return checkNotifID(`NTF_${makeID(20)}`);
    } else {
      return ntfID;
    }
  }).catch((err) => {
    console.log(err);
    return false;
  });
};

const CountAllUnreadNotifications = async (userID) => {
  const match = await notificationAudienceMatch(pool, { toUserID: userID, isRead: false }, userID);
  return await UserNotifications.count(match).then((result) => {
    return result;
  }).catch((err) => {
    console.log(err);
    return false;
  });
};

module.exports = {
  checkNotifID,
  CountAllUnreadNotifications
};
