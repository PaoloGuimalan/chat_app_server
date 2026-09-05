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
  const entityID = id;
  // const sseWithentityID = sseNotificationsWaiters[entityID];

  publish(`events_${entityID}`, "contactslist", {
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
  const entityID = id;
  // const sseWithentityID = sseNotificationsWaiters[entityID];

  publish(`events_${entityID}`, "messages_list", {
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

// --- Post activity ---------------------------------------------------------
//
// A second axis of realtime, alongside the per-entity notification stream
// above. `events_<entity_id>` is addressed to a PERSON ("something happened
// that concerns you"); this is addressed to a POST ("something happened here"),
// and reaches whoever is reading it whether or not it concerns them.
//
// CHANNEL    `post_<post_id>`
// SSE EVENT  `post_activity` - constant. The stream is already scoped to one
//            post by its channel, so naming the event after the post id would
//            only force clients to build listener names at runtime.
// BODY       {post_id, event_type, entity?, ...}, where event_type is one of
//            "comment" | "typing" | "reaction" | "share". "share" is reserved:
//            it is part of the contract so that publishing it later is a
//            server change rather than a client one, and clients must ignore
//            an event_type they do not know.
//
// The OTHER publisher on this channel is the Django user service
// (chatterloop_services/user_service/newsfeed/services/post_realtime.py),
// which raises "comment" and "reaction" because it owns the rows behind them.
// Both write the shape documented there - changing it means changing both.
// Node owns "typing" because typing is transient: it is never stored, so there
// is nothing for the service that owns comment rows to have an opinion about.
//
// Bodies carry ids and the actor's identity, never comment text. Subscribers
// refetch through the Django comments GET, which enforces post visibility.
const POST_ACTIVITY_EVENT = "post_activity";

const postActivityChannel = (postID) => `post_${postID}`;

const BroadcastPostActivity = (postID, eventType, body) => {
  publish(postActivityChannel(postID), POST_ACTIVITY_EVENT, {
    status: true,
    auth: true,
    message: eventType,
    result: {
      post_id: String(postID),
      event_type: eventType,
      ...body,
    },
  });
};

/**
 * Somebody is typing in `postID`'s comment box.
 *
 * `entity` is the typer as GetSenderDetails returns them, so the indicator can
 * name who it is rather than saying "someone". Unsigned, unlike the messenger's
 * istyping_broadcast, whose payload is JWT-wrapped: there is nothing here that
 * the subscriber could not already read off the comment list, and the stream is
 * gated on being allowed to see the post in the first place.
 *
 * `parentID` says WHICH box - null for the post's main comment box, or a
 * top-level comment's id for that comment's reply box. Carried so the
 * indicator can appear where the typing is actually happening rather than
 * always at the foot of the section, where "X is typing" gives no clue that
 * the answer is going to land inside a thread that may not even be expanded.
 * It is the same axis a comment event's `parent_id` names, so a client's
 * "which list is this about" logic is one rule rather than two.
 *
 * Client-supplied and deliberately unvalidated: a parent id that belongs to
 * some other post simply matches no thread on any subscriber's screen, so the
 * indicator does not render - and checking it would put a database round trip
 * in front of a ping that is thrown away seconds later.
 *
 * Deliberately fire-and-forget and deliberately not persisted. A typing ping
 * that arrives late is worse than one that never arrives, so nothing retries.
 */
const BroadcastCommentTyping = (postID, entityID, entity, parentID) => {
  BroadcastPostActivity(postID, "typing", {
    // Normalised to null so "" and undefined cannot read as a thread id.
    parent_id: parentID ? String(parentID) : null,
    entity: {
      entity_id: String(entityID),
      handle: entity?.handle ?? null,
      name: entity?.display_name ?? null,
      type: entity?.entity_type ?? null,
    },
  });
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
  POST_ACTIVITY_EVENT,
  postActivityChannel,
  BroadcastPostActivity,
  BroadcastCommentTyping,
};
