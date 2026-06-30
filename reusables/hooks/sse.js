let sseNotificationsWaiters = Object.create(null);

const UserNotifications = require("../../schema/users/notifications");
const UserMessage = require("../../schema/messages/message");
const UserContacts = require("../../schema/users/contacts");
const { createJWTwExp } = require("./jwthelper");
const { CountAllUnreadNotifications } = require("../models/notifications");
const { publish } = require("../redis/pubsub");
const pool = require("../../reusables/database/postgres");

const SSENotificationsTrigger = async (type, ids, details) => {
  // const sseWithUserID = sseNotificationsWaiters[ids.sendFromUser];
  // const sseWithUserIDRes = sseNotificationsWaiters[ids.sendToUser];

  // if (sseWithUserID) {
  if (ids.sendFromUser) {
    // console.log(ids.sendFromUser)
    if (type == "info_contact_decline") {
      NotificicationTrigger(ids.sendFromUser, details.actionlog);
    } else if (type == "info_contact_accept") {
      NotificicationTrigger(ids.sendFromUser, details.actionlog);
      ContactListTrigger(ids.sendFromUser, details.actionlog);
    } else if (type == "contact_request") {
      NotificicationTrigger(ids.sendFromUser, details.actionlog);
    }
  }
  // }

  // if (sseWithUserIDRes) {
  if (ids.sendToUser) {
    // console.log(ids.sendToUser)
    if (type == "info_contact_decline") {
      NotificicationTrigger(ids.sendToUser, details.sendToDetails);
    } else if (type == "info_contact_accept") {
      NotificicationTrigger(ids.sendToUser, details.sendToDetails);
      ContactListTrigger(ids.sendToUser, details.sendToDetails);
    } else if (type == "contact_request") {
      NotificicationTrigger(ids.sendToUser, details.sendToDetails);
    }
  }
  // }
};

const NotificicationTrigger = async (id, details) => {
  // const sseWithUserID = sseNotificationsWaiters[id];
  const UnreadNotificationsTotal = await CountAllUnreadNotifications(id);

  publish(`events_${id}`, `notifications`, {
    status: true,
    auth: true,
    message: details,
    result: "", //encodedResult
  });
};

const SendTagPostNotification = async (details, userID) => {
  // const sseWithUserID = sseNotificationsWaiters[userID];
  const UnreadNotificationsTotal = await CountAllUnreadNotifications(userID);

  await UserNotifications.aggregate([
    {
      $match: {
        toUserID: userID,
      },
    },
    {
      $lookup: {
        from: "useraccount",
        localField: "fromUserID",
        foreignField: "userID",
        as: "fromUser",
      },
    },
    {
      $unwind: {
        path: "$fromUser",
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $sort: { _id: -1 },
    },
    {
      $limit: 10,
    },
    {
      $project: {
        "fromUser._id": 0,
        "fromUser.birthdate": 0,
        "fromUser.gender": 0,
        "fromUser.email": 0,
        "fromUser.password": 0,
        "fromUser.dateCreated": 0,
      },
    },
  ])
    .then((result) => {
      // console.log(result)
      var encodedResult = createJWTwExp({
        notifications: result,
        totalunread: UnreadNotificationsTotal,
      });

      publish(`events_${userID}`, "notifications", {
        status: true,
        auth: true,
        message: details,
        result: encodedResult,
      });
    })
    .catch((err) => {
      console.log(err);

      publish(`events_${userID}`, "notifications", {
        status: false,
        auth: true,
        message: "Error retrieving notifications",
      });
    });
};

const ContactListTrigger = async (id, details) => {
  const userID = id;
  // const sseWithUserID = sseNotificationsWaiters[userID];

  publish(`events_${userID}`, "contactslist", {
    status: true,
    auth: true,
    message: details,
    result: "",
  });
};

function removeNullServerDetails(obj) {
  // Check if serverdetails key exists and its value is null or undefined
  if (
    Object.hasOwn(obj, "serverdetails") &&
    (obj.serverdetails === null || obj.serverdetails === undefined)
  ) {
    delete obj.serverdetails;
  }
  return obj;
}

const MessagesTrigger = async (id, details, onseen) => {
  const userID = id;
  // const sseWithUserID = sseNotificationsWaiters[userID];

  publish(`events_${userID}`, "messages_list", {
    status: true,
    auth: true,
    onseen: onseen,
    message: details,
    result: "",
  });
};

const ReloadUserNotification = async (id, details) => {
  const entity_id = id;
  // const sseWithUserID = sseNotificationsWaiters[userID];

  publish(`events_${entity_id}`, `notifications_reload`, {
    status: true,
    auth: true,
    message: details,
    result: "", //encodedResult
  });
};

const BroadcastIsTypingStatus = (receiver, data) => {
  // const sseWithUserID = sseNotificationsWaiters[receiver];

  var encodedResult = createJWTwExp({
    istyping: data,
  });

  publish(`events_${receiver}`, "istyping_broadcast", {
    status: true,
    auth: true,
    message: "istyping broadcast",
    result: encodedResult,
  });
};

const BroadcastCoordinates = (receiver, data) => {
  var encodedResult = createJWTwExp(data);

  publish(`events_${receiver}`, "coordinates_broadcast", {
    status: true,
    auth: true,
    message: "coordinates_broadcast",
    result: encodedResult,
  });
};

const ReachCallRecepients = (rcp, decodedToken) => {
  // const sseWithUserID = sseNotificationsWaiters[rcp];
  const message =
    decodedToken.conversationType == "single"
      ? `${decodedToken.callDisplayName} wants to have a ${
          decodedToken.callType == "audio" ? "call" : "video call"
        }`
      : `${decodedToken.caller.name} is calling in ${decodedToken.callDisplayName}`;

  const encodedResult = createJWTwExp({
    callmetadata: decodedToken,
  });

  publish(`events_${rcp}`, `incomingcall`, {
    status: true,
    auth: true,
    message: message,
    result: encodedResult,
  });
};

const ReachVoiceRecepients = (rcp, decodedToken) => {
  const encodedResult = createJWTwExp({
    voice_participant: decodedToken,
  });

  publish(`events_${rcp}`, `voice-joined`, {
    status: true,
    auth: true,
    result: encodedResult,
  });
};

const CallRejectNotif = (rcp, decodedToken) => {
  // const sseWithUserID = sseNotificationsWaiters[rcp];

  const encodedResult = createJWTwExp({
    rejectdata: decodedToken,
  });

  publish(`events_${rcp}`, `callreject`, {
    status: true,
    auth: true,
    result: encodedResult,
  });
};

const UpdateContactswSessionStatus = (rcp, decodedToken) => {
  // const sseWithUserID = sseNotificationsWaiters[rcp];

  const encodedResult = createJWTwExp({
    user: decodedToken,
  });

  publish(`events_${rcp}`, `active_users`, {
    status: true,
    auth: true,
    result: encodedResult,
  });
};

const clearASingleSession = (tokenfromsse, sessionstamp) => {
  const connectionID = tokenfromsse;
  const ifexistingsession = sseNotificationsWaiters[connectionID];

  if (ifexistingsession) {
    const minusmutatesession = ifexistingsession.response.filter(
      (flt) => flt.sessionstamp != sessionstamp,
    );

    if (minusmutatesession.length > 0) {
      sseNotificationsWaiters[connectionID] = {
        response: minusmutatesession,
      };
    } else {
      delete sseNotificationsWaiters[connectionID];
    }
  }
};

const clearAllSession = () => {
  sseNotificationsWaiters = Object.create(null);
};

module.exports = {
  sseNotificationsWaiters,
  SSENotificationsTrigger,
  NotificicationTrigger,
  SendTagPostNotification,
  MessagesTrigger,
  ContactListTrigger,
  ReloadUserNotification,
  BroadcastIsTypingStatus,
  ReachCallRecepients,
  CallRejectNotif,
  UpdateContactswSessionStatus,
  clearASingleSession,
  clearAllSession,
  BroadcastCoordinates,
  ReachVoiceRecepients,
};
