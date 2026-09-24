require("dotenv").config();
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const Axios = require("axios");
const sse = require("sse-express");
const readable = require("stream").Readable;
const firebase = require("firebase-admin");
const fstorage = require("firebase-admin/storage");
const {
  FIREBASE_TYPE,
  FIREBASE_PROJECT_ID,
  FIREBASE_PRIVATE_KEY_ID,
  FIREBASE_PRIVATE_KEY,
  FIREBASE_CLIENT_EMAIL,
  FIREBASE_CLIENT_ID,
  FIREBASE_AUTH_URI,
  FIREBASE_TOKEN_URI,
  FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
  FIREBASE_CLIENT_X509_CERT_URL,
  FIREBASE_UNIVERSE_DOMAIN,
  FIREBASE_STORAGE_BUCKET,
} = require("../../reusables/vars/firebasevars");
const {
  listen,
  addParticipant,
  getAllParticipants,
} = require("../../reusables/redis/pubsub");
const pool = require("../../reusables/database/postgres");
const { v4: uuidv4 } = require("uuid");
const Storage = require("../../reusables/hooks/storage");
const { MAX_UPLOAD_FILE_SIZE } = require("../../reusables/vars/uploads");
const multiparty = require("multiparty");
const push = require("../../reusables/hooks/pushnotification");
const fs = require("fs/promises");

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
  universe_domain: FIREBASE_UNIVERSE_DOMAIN,
};

// const firebaseinit = firebase.initializeApp({
//     credential: firebase.credential.cert(firebaseAdminConfig),
//     storageBucket: FIREBASE_STORAGE_BUCKET
// });
// const storage = fstorage.getStorage(firebaseinit.storage().app)

const UserAccount = require("../../schema/auth/useraccount");
const UserVerification = require("../../schema/auth/userverification");
const UserContacts = require("../../schema/users/contacts");
const UserNotifications = require("../../schema/users/notifications");
const UserMessage = require("../../schema/messages/message");
const ChatHistory = require("../../schema/messages/chathistory");
const UserGroups = require("../../schema/users/groups");
const UserServers = require("../../schema/users/servers");
const UploadedFiles = require("../../schema/posts/uploadedfiles");
const UserSessions = require("../../schema/auth/sessions");
// Shared with the presence fan-out that developer_service triggers, so the
// snapshot this file serves and the live pushes a client receives afterwards
// can never disagree about who is in scope.
const { getPresenceScope } = require("../../reusables/hooks/presence");

const dateGetter = require("../../reusables/hooks/getDate");
const timeGetter = require("../../reusables/hooks/getTime");
const makeID = require("../../reusables/hooks/makeID");
const { queueCommand } = require("../../reusables/hooks/queueCommand");
const {
  REPLIED_MESSAGE_LOOKUP,
  LEGACY_REPLYING_TO_EXPR,
  legacyReplyingTo,
  hydrateReplyTargets,
  sanitizeIncomingReplyingTo,
  assertCanReplyTo,
  repliedMessageID,
  replyPreviewLabel,
  POST_MESSAGE_TYPE,
  POST_MESSAGE_PREVIEW,
} = require("../../reusables/hooks/replyTargets");
const { parseCommand } = require("../../reusables/hooks/commandParser");
const {
  base64ToArrayBuffer,
  dataURLtoFile,
} = require("../../reusables/hooks/base64toFile");
const { format } = require("path");
const {
  GetAllMessageCountInAConversation,
} = require("../../reusables/models/conversation");
const {
  sseNotificationsWaiters,
  ReloadUserNotification,
  clearASingleSession,
  ContactListTrigger,
  SSENotificationsTrigger,
  MessagesTrigger,
  ReachCallRecepients,
  UpdateContactswSessionStatus,
  CallRejectNotif,
  BroadcastCoordinates,
  ReachVoiceRecepients,
} = require("../../reusables/hooks/sse");
const {
  storage,
  uploadFirebaseMultiple,
  uploadFirebase,
  saveFileRecordToDatabase,
} = require("../../reusables/hooks/firebaseupload");
const {
  CountAllUnreadNotifications,
} = require("../../reusables/models/notifications");
const makeid = require("../../reusables/hooks/makeID");
const {
  GetAllReceivers,
  GetRealmsJoined,
  SaveConversation,
  SyncConversationLastMessage,
  normalizeConversationType,
  queueMessageTagging,
} = require("../../reusables/models/messages");
const { GetServerMembers } = require("../../reusables/models/server");
const {
  attachNotificationUx,
  paramsFor,
} = require("../../reusables/models/notificationactions");
const {
  createJWT,
  jwtchecker,
  jwtssechecker,
} = require("../../reusables/hooks/jwthelper");
const {
  requiresPermission,
  hasPermission,
} = require("../../reusables/hooks/permissionChecker");
const producer = require("../../reusables/rabbitmq/producer");
const {
  SSE_NOTIFICATIONS_TRIGGER,
  MESSAGES_TRIGGER_LOOPER,
  CONTACT_LIST_TRIGGER_LOOPER,
  REACH_CALL_RECEPIENTS_LOOPER,
  UPDATE_CONTATCS_W_SESSION_STATUS_LOOPER,
  CALL_REJECT_NOTIF,
  CALL_REJECT_NOTIF_LOOPER,
} = require("../../reusables/vars/rabbitmqevents");
const { publish, stop_listen } = require("../../reusables/redis/pubsub");
const {
  sanitizeForStorage,
  extractMentionUsernames,
} = require("../../reusables/hooks/transformers");
const {
  GetListOfContactsV2,
  GetUsersFromConnections,
  GetUsersWithConnectionIDs,
  CreateEntity,
  GetSenderDetails,
  GetEntityHandles,
} = require("../../reusables/models/users");
const {
  isRealmMember,
  GetRealmName,
} = require("../../reusables/models/realms");
const {
  bumpChatScore,
  interactionScoreBump,
} = require("../../reusables/hooks/interactionscoring");
const {
  findOrCreateDirectConversation,
} = require("../../reusables/models/directConversation");
const {
  POST_KINDS,
  postVisibleToSQL,
  updateRankingScore,
  logPostShare,
} = require("../../reusables/models/posts");
const Conversations = require("../../schema/messages/conversation");

const MAILINGSERVICE_DOMAIN = process.env.MAILINGSERVICE;
const JWT_SECRET = process.env.JWT_SECRET;
const LINK_PREVIEW_SERVICE_URL = process.env.LINK_PREVIEW_SERVICE_URL;
const INTERNAL_SERVICE_SECRET = process.env.INTERNAL_SERVICE_SECRET;

// Fire-and-forget: resolves a link preview for a just-sent text message via
// the Django user_service (centralized SSRF-guarded fetch/parse/cache -
// see newsfeed/services/link_preview.py) and patches the result onto the
// already-saved message, then pushes a follow-up SSE event so clients that
// already rendered the message can upgrade it in place. Never awaited by
// the /sendMessage handler - a slow/broken Django call must never delay a
// chat send.
async function resolveLinkPreviewForMessage(
  messageID,
  conversationID,
  content,
  receivers,
  senderEntityID,
) {
  if (!LINK_PREVIEW_SERVICE_URL || !INTERNAL_SERVICE_SECRET) {
    console.log(
      "[linkPreview] skipped: LINK_PREVIEW_SERVICE_URL/INTERNAL_SERVICE_SECRET not set in this process's environment (server restart needed after editing .env)",
    );
    return;
  }

  let linkPreview = { status: "failed" };

  try {
    const response = await Axios.post(
      LINK_PREVIEW_SERVICE_URL,
      { text: content },
      {
        headers: { "X-Internal-Service-Secret": INTERNAL_SERVICE_SECRET },
        timeout: 6000,
      },
    );
    if (response.data) {
      linkPreview = response.data;
    }
  } catch (err) {
    console.log("[linkPreview] resolve failed:", err.message || err);
  }

  // No URL in the message at all - nothing to store, skip the write/push.
  if (!linkPreview.url) return;

  try {
    await UserMessage.updateOne(
      { messageID: messageID },
      { $set: { linkPreview: linkPreview } },
    );
  } catch (err) {
    console.log("[linkPreview] failed to persist:", err.message || err);
    return;
  }

  // Reuse the same "messages_list" SSE channel real new-message delivery
  // already uses (see MessagesTrigger below and its listener in the webapp's
  // reusables/hooks/sse.ts, which dispatches a per-conversation "reload"
  // CustomEvent that ConversationV2.tsx/Conversation.tsx already listen for
  // and react to by refetching via GetConversation()) rather than a bespoke
  // event nothing on the frontend was ever wired to consume. Includes the
  // sender too, not just receivers - they're the one who pasted the URL and
  // need their own open conversation view to pick up the resolved preview
  // without navigating away and back.
  const notifyOfPreviewUpdate = [...new Set([...receivers, senderEntityID])];
  notifyOfPreviewUpdate.map((rcvs) => {
    MessagesTrigger(rcvs, { conversationID, entityID: senderEntityID }, false);
  });
}

router.get("/search/:searchdata", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const searchdata = req.params.searchdata;

  if (searchdata.split("")[0] == "@") {
    await UserAccount.aggregate([
      {
        $match: {
          isActivated: true,
          isVerified: true,
          userID: { $regex: searchdata.split("@")[1], $options: "i" },
        },
      },
      {
        $lookup: {
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
                        { $in: ["$$actionByUserID", "$users.userID"] },
                      ],
                    },
                    {
                      $and: [
                        { $eq: ["$$actionByUserID", "$actionBy"] },
                        { $in: [userID, "$users.userID"] },
                      ],
                    },
                  ],
                },
              },
            },
          ],
          as: "contacts",
        },
      },
      {
        $unwind: {
          path: "$contacts",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $lookup: {
          from: "notifications",
          localField: "contacts.contactID",
          foreignField: "referenceID",
          as: "notification",
        },
      },
      {
        $project: {
          password: 0,
          birthdate: 0,
          gender: 0,
          email: 0,
          isActivated: 0,
          isVerified: 0,
        },
      },
    ])
      .then((result) => {
        // console.log(result)
        var encodedResult = jwt.sign(
          {
            searchresults: result,
          },
          JWT_SECRET,
          {
            expiresIn: 60 * 60 * 24 * 7,
          },
        );

        res.send({ status: true, result: encodedResult });
      })
      .catch((err) => {
        console.log(err);
        res.send({
          status: false,
          message: `Error searching for ${searchdata}`,
        });
      });
  } else {
    await UserAccount.aggregate([
      {
        $match: {
          isActivated: true,
          isVerified: true,
          $or: [
            { "fullname.firstName": { $regex: searchdata, $options: "i" } },
            { "fullname.middleName": { $regex: searchdata, $options: "i" } },
            { "fullname.lastName": { $regex: searchdata, $options: "i" } },
          ],
        },
      },
      {
        $lookup: {
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
                        { $in: ["$$actionByUserID", "$users.userID"] },
                      ],
                    },
                    {
                      $and: [
                        { $eq: ["$$actionByUserID", "$actionBy"] },
                        { $in: [userID, "$users.userID"] },
                      ],
                    },
                  ],
                },
              },
            },
          ],
          as: "contacts",
        },
      },
      {
        $unwind: {
          path: "$contacts",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $lookup: {
          from: "notifications",
          localField: "contacts.contactID",
          foreignField: "referenceID",
          as: "notification",
        },
      },
      {
        $project: {
          password: 0,
          birthdate: 0,
          gender: 0,
          email: 0,
          isActivated: 0,
          isVerified: 0,
        },
      },
    ])
      .then((result) => {
        // console.log(result)
        var encodedResult = jwt.sign(
          {
            searchresults: result,
          },
          JWT_SECRET,
          {
            expiresIn: 60 * 60 * 24 * 7,
          },
        );

        res.send({ status: true, result: encodedResult });
      })
      .catch((err) => {
        console.log(err);
        res.send({
          status: false,
          message: `Error searching for ${searchdata}`,
        });
      });
  }
});

const sendNotification = async (params, actionlog) => {
  const sendToUser = params.toUserID;
  const sendToDetails = params.content.details;
  const sendFromUser = params.fromUserID;
  const type = params.type;
  // Decided here rather than at read time: a notice addressed to an audience
  // ("all", "region:PH", ...) is a single shared document and is stored
  // already-read, since no per-viewer read state can exist on it. See
  // resolveNotificationIsRead.
  const newNotif = new UserNotifications({
    ...params,
    isRead: resolveNotificationIsRead(params),
  });

  newNotif
    .save()
    .then(async () => {
      SSENotificationsTrigger(
        type,
        {
          sendToUser: sendToUser,
          sendFromUser: sendFromUser,
        },
        {
          sendToDetails: sendToDetails,
          actionlog: actionlog,
        },
      );

      // const events = [`events_${sendToUser}`, `events_${sendFromUser}`];

      // events.map((mp) => {
      //   publish(mp, SSE_NOTIFICATIONS_TRIGGER, {
      //     parameters: {
      //       type: type,
      //       ids: {
      //         sendToUser: sendToUser,
      //         sendFromUser: sendFromUser,
      //       },
      //       details: {
      //         sendToDetails: sendToDetails,
      //         actionlog: actionlog,
      //       },
      //     },
      //   });
      // });

      //   await producer.publishMessage(
      //     "INFO:CHATTERLOOP",
      //     SSE_NOTIFICATIONS_TRIGGER,
      //     {
      //       parameters: {
      //         type: type,
      //         ids: {
      //           sendToUser: sendToUser,
      //           sendFromUser: sendFromUser,
      //         },
      //         details: {
      //           sendToDetails: sendToDetails,
      //           actionlog: actionlog,
      //         },
      //       },
      //     }
      //   );
      // SSENotificationsTrigger(type, sendFromUser, actionlog)
    })
    .catch((err) => {
      console.log(err);
    });
};

const checkContactID = async (cnctID) => {
  return await UserContacts.find({ contactID: cnctID })
    .then((result) => {
      if (result.length) {
        checkContactID(`${makeID(20)}`);
      } else {
        return cnctID;
      }
    })
    .catch((err) => {
      console.log(err);
      return false;
    });
};

const checkGroupID = async (cnctID) => {
  const { rows } = await pool.query(
    `SELECT realm_id FROM community_realm WHERE realm_id = $1`,
    [cnctID],
  );

  if (rows.length > 0) {
    return checkGroupID(`${makeID(20)}`);
  }

  return cnctID;

  // return await UserContacts.find({ contactID: cnctID })
  //   .then((result) => {
  //     if (result.length) {
  //       checkGroupID(`${makeID(20)}`);
  //     } else {
  //       return cnctID;
  //     }
  //   })
  //   .catch((err) => {
  //     console.log(err);
  //     return false;
  //   });
};

const checkConferenceSlug = async (slug) => {
  const { rows } = await pool.query(
    `
      SELECT EXISTS (
        SELECT 1 FROM user_account WHERE username = $1
        UNION ALL
        SELECT 1 FROM community_realm WHERE slug = $1
      ) as slug_exists
    `,
    [slug],
  );

  if (rows[0]?.slug_exists) {
    return checkConferenceSlug(`${makeID(6)}`);
  }

  return slug;
};

const checkServerID = async (cnctID) => {
  return await UserServers.find({ serverID: cnctID })
    .then((result) => {
      if (result.length) {
        checkServerID(`${makeID(20)}`);
      } else {
        return cnctID;
      }
    })
    .catch((err) => {
      console.log(err);
      return false;
    });
};

const checkNotifID = async (ntfID) => {
  return await UserNotifications.find({ notificationID: ntfID })
    .then((result) => {
      if (result.length) {
        checkNotifID(`NTF_${makeID(20)}`);
      } else {
        return ntfID;
      }
    })
    .catch((err) => {
      console.log(err);
      return false;
    });
};

const checkContactRequest = async (requesterID, responderID) => {
  return await UserContacts.find({
    "users.userID": { $all: [requesterID, responderID] },
  })
    .then((result) => {
      if (result.length > 0) {
        return false;
      } else {
        return true;
      }
    })
    .catch((err) => {
      console.log(err);
      return false;
    });
};

router.post(
  "/requestContact",
  jwtchecker,
  requiresPermission("contacts.request.create"),
  async (req, res) => {
    const userID = req.params.userID;
    const token = req.body.token;

    try {
      const decodeToken = jwt.verify(token, JWT_SECRET);

      const contactID = await checkContactID(`${makeID(20)}`);
      const addUserID = decodeToken.addUserID;

      const payload = {
        contactID: contactID,
        actionBy: userID,
        actionDate: {
          date: dateGetter(),
          time: timeGetter(),
        },
        status: false,
        type: "single",
        users: [
          {
            userID: userID,
          },
          {
            userID: addUserID,
          },
        ],
      };

      // if (await checkContactRequest(userID, addUserID)) {
      //   const newContact = new UserContacts(payload);

      //   newContact
      //     .save()
      //     .then(async () => {
      const awaitNotifID = await checkNotifID(`NTF_${makeID(20)}`);
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
          time: timeGetter(),
        },
        type: "contact_request",
      };

      sendNotification(notifParams, "You have sent a contact request");

      res.send({
        status: true,
        message: `You have sent a contact request to @${addUserID}`,
      });
      // })
      // .catch((err) => {
      //   res.send({
      //     status: false,
      //     message: "Contact request encountered an error!",
      //   });
      //   console.log(err);
      // });
      // }
    } catch (ex) {
      res.send({
        status: false,
        message: "Contact request encountered an error!",
      });
      console.log(ex);
    }
  },
);

router.post("/readnotifications", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const entity_id = req.params.entity_id;

  if (entity_id) {
    await UserNotifications.updateMany(
      { toUserID: entity_id, isRead: false },
      { isRead: true },
    )
      .then(async (result) => {
        ReloadUserNotification(entity_id, "Notifications has been read");
        res.send({ status: true, message: "Notifications has been read" });
      })
      .catch((err) => {
        console.log(err);
        res.send({
          status: false,
          message: "Error marking notifications as read",
        });
      });
  } else {
    res.send({ status: false, message: "No userID received" });
  }
});

router.get("/getNotifications", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const entity_id = req.params.entity_id;
  const page = req.headers["page"];
  const range = req.headers["range"];
  const UnreadNotificationsTotal = await CountAllUnreadNotifications(entity_id);

  await UserNotifications.aggregate([
    {
      $match: {
        toUserID: entity_id,
      },
    },
    {
      $facet: {
        metadata: [{ $count: "total" }],
        data: [
          { $sort: { _id: -1 } },
          { $skip: (parseInt(page) - 1) * parseInt(range) },
          { $limit: parseInt(range) },
        ],
      },
    },
    {
      $project: {
        data: 1,
        total: { $arrayElemAt: ["$metadata.total", 0] },
      },
    },
  ])
    .then(async (result_raw) => {
      const result = result_raw[0].data;
      const total = result_raw[0].total;
      const next = total - range * page > 0;
      const userIDs = result.map((mp) => mp.fromUserID);
      const uniqueIDs = [...new Set(userIDs)];

      const { rows } = await pool.query(
        "SELECT id, username, gender, profile, is_active, is_verified FROM user_account WHERE entity_id = ANY($1);",
        [uniqueIDs],
      );

      const finalNotification = result.map((mp) => {
        const fromUser =
          rows.filter((flt) => flt.id === mp.fromUserID).length > 0
            ? rows.filter((flt) => flt.id === mp.fromUserID)[0]
            : null;
        // Same redirects/actions as v2. Additive only - every existing field is
        // untouched, so the pinned mobile client keeps reading what it always
        // read and simply ignores the two new keys.
        return {
          ...attachNotificationUx(mp, paramsFor(mp, fromUser)),
          fromUser,
        };
      });

      var encodedResult = jwt.sign(
        {
          notifications: finalNotification,
          totalunread: UnreadNotificationsTotal,
          total,
          next,
        },
        JWT_SECRET,
        {
          expiresIn: 60 * 60 * 24 * 7,
        },
      );

      res.send({ status: true, result: encodedResult });
    })
    .catch((err) => {
      console.log(err);
      res.send({ status: false, message: "Error retrieving notifications" });
    });
});

// ---------------------------------------------------------------------------
// Notifications v2 - sectioned endpoints for the redesigned Notifications
// page (Activity / Connections / System columns). NEW routes only: the live
// mobile app pins /getNotifications and /readnotifications, so those stay
// exactly as-is above.
//
// Section membership is decided by the notification `type`:
//   - connections: contact/relationship lifecycle
//   - system:      platform announcements (no generator writes these yet -
//                  the column intentionally renders empty until one exists)
//   - activity:    EVERYTHING else ($nin) - the default bucket, so any new
//                  type added later surfaces in Activity instead of vanishing.
const NOTIF_CONNECTION_TYPES = [
  "contact_request",
  "info_contact_accept",
  "info_contact_decline",
  // Written by the Django follow endpoint (community/views.py
  // FollowRealmView.post) on each NEW follow edge.
  "follow",
  // Same endpoint, but for a follow of a PRIVATE profile, which lands
  // pending instead of established. Actionable: it carries
  // referenceStatus=false and referenceID=<requester entity id>, and the
  // client answers it with PUT /api/community/follow + an `action` header of
  // approve/decline. Belongs in Connections, not Activity - it is the same
  // relationship lifecycle as a contact request.
  "follow_request",
];
const NOTIF_SYSTEM_TYPES = ["system"];

// For SYSTEM notifications, `toUserID` is an AUDIENCE SELECTOR rather than a
// plain recipient id. A system notification is addressed to one of:
//   <entity id>     - just this entity (the default, and how every other
//                     notification type works)
//   "all"           - broadcast, fetched by everyone
//   "region:<code>" - everyone in a region (planned)
//   <group tag>     - any future cohort
//
// Only the system section widens its match this way; activity and
// connections stay strictly direct-addressed.
const SYSTEM_AUDIENCE_ALL = "all";
const SYSTEM_AUDIENCE_REGION_PREFIX = "region:";
const SYSTEM_AUDIENCE_GROUP_PREFIX = "group:";

/**
 * Is this `toUserID` addressed at MANY recipients rather than one entity?
 *
 * Audience selectors are the reserved value "all" and anything carrying a
 * grouping prefix ("region:PH", "group:beta", ...). Everything else is a
 * plain entity id, i.e. one recipient. New grouping dimensions only need
 * their prefix registered here and in buildSystemAudience().
 */
const isSystemAudienceSelector = (toUserID) => {
  const tag = String(toUserID || "");
  return (
    tag === SYSTEM_AUDIENCE_ALL ||
    tag.startsWith(SYSTEM_AUDIENCE_REGION_PREFIX) ||
    tag.startsWith(SYSTEM_AUDIENCE_GROUP_PREFIX)
  );
};

/**
 * Read state for a notification AT CREATION TIME.
 *
 * A notice addressed to many people is one shared document, so it can never
 * carry per-viewer read state - tracking every reader would mean appending
 * each of them to the document forever. It is therefore stored already-read:
 * it still shows up in everyone's System section, it just never badges and
 * can never strand a permanent unread count that no read call could clear.
 *
 * A notice addressed to a single entity behaves exactly as every other
 * notification: created unread, flipped by POST /u/readnotifications.
 */
const resolveNotificationIsRead = (params) => {
  if (isSystemAudienceSelector(params.toUserID)) {
    return true;
  }
  // Addressed to ONE entity, so it is personal - and a personal notice starts
  // unread, full stop. Derived rather than taken from the caller: an
  // `isRead: true` on a direct notification means the recipient is never told
  // about something that concerns only them, which is a silent failure and
  // exactly the kind a default gets wrong. Broadcasts are the only exception,
  // and they are handled above.
  return false;
};

/**
 * Every audience tag the given entity should receive system notices under.
 *
 * This is the single extension point for grouped targeting: adding a new
 * dimension later (region, cohort, plan tier, ...) means pushing its tag
 * here, and both the fetch and the read-state paths pick it up for free.
 * `context` is intentionally open-ended and empty today - region resolution
 * is not wired up yet.
 */
const buildSystemAudience = (entity_id, context = {}) => {
  const tags = [entity_id, SYSTEM_AUDIENCE_ALL];

  if (context.region) {
    tags.push(`${SYSTEM_AUDIENCE_REGION_PREFIX}${context.region}`);
  }
  if (Array.isArray(context.groups)) {
    tags.push(...context.groups.filter(Boolean));
  }

  return tags;
};

const notificationSectionMatch = (entity_id, section, audienceContext) => {
  if (section === "connections") {
    return { toUserID: entity_id, type: { $in: NOTIF_CONNECTION_TYPES } };
  }
  if (section === "system") {
    return {
      toUserID: { $in: buildSystemAudience(entity_id, audienceContext) },
      type: { $in: NOTIF_SYSTEM_TYPES },
    };
  }
  return {
    toUserID: entity_id,
    type: { $nin: [...NOTIF_CONNECTION_TYPES, ...NOTIF_SYSTEM_TYPES] },
  };
};

// Same $facet shape as v1 getNotifications above, plus an unread facet so
// the section headers can render their badges without a second query.
//
// Read state needs no special handling here: it is decided once at creation
// (see resolveNotificationIsRead). An audience-addressed notice is stored
// already-read because its single document is shared by every recipient and
// could never track per-viewer state; a directly-addressed one is stored
// unread and /readnotifications flips it as usual.
const fetchNotificationSection = async (match, page, range) => {
  const result_raw = await UserNotifications.aggregate([
    { $match: match },
    {
      $facet: {
        metadata: [{ $count: "total" }],
        unread: [{ $match: { isRead: false } }, { $count: "total" }],
        data: [
          { $sort: { _id: -1 } },
          { $skip: (parseInt(page) - 1) * parseInt(range) },
          { $limit: parseInt(range) },
        ],
      },
    },
    {
      $project: {
        data: 1,
        total: { $arrayElemAt: ["$metadata.total", 0] },
        unread: { $arrayElemAt: ["$unread.total", 0] },
      },
    },
  ]);

  const items = result_raw[0].data;
  const total = result_raw[0].total || 0;
  const unread = result_raw[0].unread || 0;
  const next = total - range * page > 0;
  return { items, total, unread, next };
};

// Resolve senders through entity_entity so PAGE-authored notifications get a
// display identity too (v1 joins user_account only and hands back null for
// realms). Same COALESCE join shape as GetAllReceivers in
// reusables/models/messages.js.
const enrichNotificationSenders = async (itemsPerSection) => {
  const allItems = itemsPerSection.flat();
  const uniqueIDs = [
    ...new Set(allItems.map((mp) => mp.fromUserID).filter(Boolean)),
  ];
  if (uniqueIDs.length === 0) return new Map();

  const { rows } = await pool.query(
    // BOTS are the third entity kind, and the moderation bot is the first
    // sender that is one. Without this join a bot notification came back with
    // a null handle, a null display_name and a null profile - the row rendered
    // nameless and avatarless, which is exactly what "Content removed" must
    // not look like.
    //
    `SELECT
       e.id AS entity_id,
       e.type,
       COALESCE(u.username, r.slug, b.handle) AS handle,
       COALESCE(NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), r.name, b.name) AS display_name,
       COALESCE(u.profile, r.profile, b.profile) AS profile,
       COALESCE(u.is_badged, r.is_verified, b.is_verified, false) AS is_verified
     FROM entity_entity e
     LEFT JOIN user_account u ON u.entity_id = e.id AND e.type = 'user'
     LEFT JOIN community_realm r ON r.entity_id = e.id AND e.type = 'realm'
     LEFT JOIN bot_bot b ON b.entity_id = e.id AND e.type = 'bot'
     WHERE e.id = ANY($1);`,
    [uniqueIDs],
  );

  const senderMap = new Map();
  rows.forEach((row) => {
    senderMap.set(String(row.entity_id), {
      entity_id: row.entity_id,
      type: row.type,
      display_name: row.display_name,
      handle: row.handle,
      profile:
        row.profile && row.profile !== "none" && row.profile !== "N/A"
          ? row.profile
          : null,
      is_verified: !!row.is_verified,
    });
  });
  return senderMap;
};

const attachNotificationSenders = (items, senderMap) =>
  items.map((mp) => {
    const fromUser = senderMap.get(String(mp.fromUserID)) || null;
    // The row's destination and buttons ride along with the sender, because
    // this is the only point that has both the notification and the resolved
    // identity a profile route needs. See notificationactions.js - stored
    // values win, everything else is derived from `type`.
    return {
      ...attachNotificationUx(mp, paramsFor(mp, fromUser)),
      fromUser,
    };
  });

// Page-init: all three section previews (+ totals and unread counts) in one
// round-trip. The per-section routes below drive the infinite scrolls.
router.get("/v2/notifications/overview", jwtchecker, async (req, res) => {
  const entity_id = req.params.entity_id;
  const previewRange = parseInt(req.headers["range"]) || 8;

  try {
    const [activity, connections, system] = await Promise.all([
      fetchNotificationSection(
        notificationSectionMatch(entity_id, "activity"),
        1,
        previewRange,
      ),
      fetchNotificationSection(
        notificationSectionMatch(entity_id, "connections"),
        1,
        previewRange,
      ),
      fetchNotificationSection(
        notificationSectionMatch(entity_id, "system"),
        1,
        previewRange,
      ),
    ]);

    const senderMap = await enrichNotificationSenders([
      activity.items,
      connections.items,
      system.items,
    ]);

    const encodedResult = jwt.sign(
      {
        activity: {
          items: attachNotificationSenders(activity.items, senderMap),
          total: activity.total,
          unread: activity.unread,
          next: activity.next,
        },
        connections: {
          items: attachNotificationSenders(connections.items, senderMap),
          total: connections.total,
          unread: connections.unread,
          next: connections.next,
        },
        system: {
          items: attachNotificationSenders(system.items, senderMap),
          total: system.total,
          unread: system.unread,
          next: system.next,
        },
      },
      JWT_SECRET,
      {
        expiresIn: 60 * 60 * 24 * 7,
      },
    );

    res.send({ status: true, result: encodedResult });
  } catch (err) {
    console.log(err);
    res.send({
      status: false,
      message: "Error retrieving notifications overview",
    });
  }
});

const notificationSectionRoute = (section) => async (req, res) => {
  const entity_id = req.params.entity_id;
  const page = parseInt(req.headers["page"]) || 1;
  const range = parseInt(req.headers["range"]) || 20;

  try {
    const data = await fetchNotificationSection(
      notificationSectionMatch(entity_id, section),
      page,
      range,
    );
    const senderMap = await enrichNotificationSenders([data.items]);

    const encodedResult = jwt.sign(
      {
        items: attachNotificationSenders(data.items, senderMap),
        total: data.total,
        unread: data.unread,
        next: data.next,
      },
      JWT_SECRET,
      {
        expiresIn: 60 * 60 * 24 * 7,
      },
    );

    res.send({ status: true, result: encodedResult });
  } catch (err) {
    console.log(err);
    res.send({ status: false, message: "Error retrieving notifications" });
  }
};

router.get(
  "/v2/notifications/activity",
  jwtchecker,
  notificationSectionRoute("activity"),
);
router.get(
  "/v2/notifications/connections",
  jwtchecker,
  notificationSectionRoute("connections"),
);
router.get(
  "/v2/notifications/system",
  jwtchecker,
  notificationSectionRoute("system"),
);

// NOTE: marking read stays on the existing POST /u/readnotifications. It
// matches toUserID: <entity>, so it only ever touches directly-addressed
// notifications - which is correct here: broadcasts are shared documents and
// must NOT have their single isRead flag flipped by one reader (see
// fetchNotificationSection above, which surfaces them as read instead).

const updateNotifStatus = async (
  type,
  referenceID,
  notificationID,
  toUserID,
  fromUserID,
  notifHeadline,
  notifContent,
  actionlog,
) => {
  await UserNotifications.updateOne(
    { notificationID: notificationID },
    { referenceStatus: true },
  )
    .then(async (result) => {
      const awaitNotifID = await checkNotifID(`NTF_${makeID(20)}`);
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
          time: timeGetter(),
        },
        type: type,
      };
      sendNotification(notifParams, actionlog);
    })
    .catch((err) => {
      console.log(err);
      res.send({
        status: false,
        message: "Error encountered in notifications",
      });
    });
};

router.post("/declineContactRequest", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const token = req.body.token;

  try {
    const decodedToken = jwt.verify(token, JWT_SECRET);

    const type = decodedToken.type;
    const notificationID = decodedToken.notificationID;
    const referenceID = decodedToken.referenceID;
    const toUserID = decodedToken.toUserID;
    const fromUserID = decodedToken.fromUserID;

    // await UserContacts.deleteOne({ contactID: referenceID })
    //   .then(async (result) => {
    res.send({ status: true, message: "Contact has been deleted" });
    if (type == "contact_request") {
      const notifHeadline = `Declined Request`;
      const notifContent = `${fromUserID} declined your request`;

      await updateNotifStatus(
        "info_contact_decline",
        referenceID,
        notificationID,
        toUserID,
        fromUserID,
        notifHeadline,
        notifContent,
        "You declined a contact request",
      );
    }
    // })
    // .catch((err) => {
    //   console.log(err);
    //   res.send({ status: false, message: "Error verifying decline request" });
    // });
  } catch (ex) {
    console.log(ex);
    res.send({ status: false, message: "Error declining request" });
  }
});

router.post("/acceptContactRequest", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const token = req.body.token;

  try {
    const decodedToken = jwt.verify(token, JWT_SECRET);

    const type = decodedToken.type;
    const notificationID = decodedToken.notificationID;
    const referenceID = decodedToken.referenceID;
    const toUserID = decodedToken.toUserID;
    const fromUserID = decodedToken.fromUserID;

    // await UserContacts.updateOne({ contactID: referenceID }, { status: true })
    //   .then(async (result) => {
    res.send({ status: true, message: "Contact has been accepted" });
    const notifHeadline = `Accepted Request`;
    const notifContent = `${fromUserID} accepted your request`;

    await updateNotifStatus(
      "info_contact_accept",
      referenceID,
      notificationID,
      toUserID,
      fromUserID,
      notifHeadline,
      notifContent,
      "You accepted a contact request",
    );
    // })
    // .catch((err) => {
    //   res.send({ status: false, message: "Error verifying accept request" });
    //   console.log(err);
    // });
  } catch (ex) {
    console.log(ex);
    res.send({ status: false, message: "Error accepting request" });
  }
});

router.get("/getContacts", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const page = req.headers["page"];
  const range = req.headers["range"];

  await UserContacts.aggregate([
    {
      $match: {
        $and: [
          {
            $or: [{ actionBy: userID }, { "users.userID": userID }],
          },
          {
            status: true,
          },
        ],
      },
    },
    {
      $lookup: {
        from: "contacts",
        localField: "contactID",
        foreignField: "contactID",
        let: {
          firstUserID: { $arrayElemAt: ["$users.userID", 0] },
          secondUserID: { $arrayElemAt: ["$users.userID", 1] },
        },
        pipeline: [
          {
            $lookup: {
              from: "useraccount",
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ["$userID", "$$firstUserID"] },
                        { $eq: ["$isVerified", true] },
                        { $eq: ["$isActivated", true] },
                      ],
                    },
                  },
                },
              ],
              as: "userone",
            },
          },
          {
            $unwind: {
              path: "$userone",
              preserveNullAndEmptyArrays: true,
            },
          },
          {
            $lookup: {
              from: "useraccount",
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ["$userID", "$$secondUserID"] },
                        { $eq: ["$isVerified", true] },
                        { $eq: ["$isActivated", true] },
                      ],
                    },
                  },
                },
              ],
              as: "usertwo",
            },
          },
          {
            $unwind: {
              path: "$usertwo",
              preserveNullAndEmptyArrays: true,
            },
          },
        ],
        as: "userdetails",
      },
    },
    {
      $unwind: {
        path: "$userdetails",
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $lookup: {
        from: "groups",
        localField: "contactID",
        foreignField: "groupID",
        as: "groupdetails",
      },
    },
    {
      $unwind: {
        path: "$groupdetails",
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $project: {
        "userdetails.actionBy": 0,
        "userdetails.actionDate": 0,
        "userdetails.contactID": 0,
        "userdetails.status": 0,
        "userdetails.users": 0,
        users: 0,
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
        "userdetails.usertwo.password": 0,
      },
    },
    {
      $sort: { _id: -1 },
    },
    {
      $skip: (parseInt(page) - 1) * parseInt(range),
    },
    {
      $limit: parseInt(range),
    },
    // {
    //   $facet: {
    //     metadata: [{ $count: "total" }],
    //     data: [
    //       { $sort: { _id: -1 } },
    //       { $skip: (parseInt(page) - 1) * parseInt(range) },
    //       { $limit: parseInt(range) },
    //     ],
    //   },
    // },
  ])
    .then((result) => {
      // console.log(result)
      const encodedResult = jwt.sign(
        {
          contacts: result,
        },
        JWT_SECRET,
        {
          expiresIn: 60 * 60 * 24 * 7,
        },
      );

      res.send({ status: true, result: encodedResult });
    })
    .catch((err) => {
      console.log(err);
      res.send({ status: false, message: "Error fetching contacts list" });
    });
});

const checkExistingMessageID = async (messageID) => {
  return await UserMessage.find({ messageID: messageID })
    .then((result) => {
      if (result.length > 0) {
        checkExistingMessageID(makeID(30));
      } else {
        return messageID;
      }
    })
    .catch((err) => {
      console.log(err);
      return false;
    });
};

/**
 * Sends one message as the acting entity in `params` (what jwtchecker puts on
 * req.params) - everything /sendMessage does, shared with /sendPost so a post
 * sent into a chat is an ordinary message in every respect: membership check,
 * mentions, sanitising, the conversation's last message, the realtime frame,
 * pushes, commands, chat scores.
 *
 * Resolves { pendingID, messageID } once the message is saved and the
 * conversation's last message is updated - the point /sendMessage has always
 * answered at. The realtime frames, the command queue and the pushes then run
 * in the background, exactly as they always ran after the response.
 *
 * Throws on a bad payload or a sender who is not in the conversation, and
 * with `saveFailed` set when the write itself fails.
 */
const deliverMessage = async (params, decodedToken) => {
  const userID = params.userID;
  const username = params.username;
  const id = params.id;
  const entity_id = params.entity_id;

  const pendingID = decodedToken.pendingID;

  const messageID = await checkExistingMessageID(makeID(30));
  const conversationID = decodedToken.conversationID;

  await isRealmMember(conversationID, entity_id);

  const sender = entity_id;
  const receiversfetch = await GetAllReceivers(conversationID);
  const receivers = receiversfetch.users.map((mp) => mp.entityID); //Array decodedToken.receivers

  // A post message's content is a post id, not words anyone typed.
  const mentionedUsernames = extractMentionUsernames(
    decodedToken.messageType === POST_MESSAGE_TYPE ? "" : decodedToken.content,
  );

  const receiverMap = new Map(
    receiversfetch.users.map((rcv) => [
      String(rcv.username).toLowerCase(),
      rcv.entityID,
    ]),
  );

  const mentionedReceiverIds = mentionedUsernames
    .map((usern) => receiverMap.get(usern.toLowerCase()))
    .filter(Boolean);

  const mentionedReceiverSet = new Set(mentionedReceiverIds);

  const realmName =
    decodedToken.conversationType === "single"
      ? null
      : await GetRealmName(conversationID);

  // `sender` is the ACTING entity, so a mention made while switched to a
  // page must be attributed to the page. `username` (from jwtchecker) is
  // always the human behind it, and is kept only as a fallback.
  const mentionerDetails = await GetSenderDetails(sender);

  const mentioner = {
    entityID: sender,
    username: `@${mentionerDetails?.handle || username}`,
    realmName: realmName,
    isSingle: decodedToken.conversationType === "single",
  };

  // const seeners = [userID]; //Array
  const seeners = [entity_id]; //Array
  const content = decodedToken.content;
  // const messageDate = {
  //   date: dateGetter(),
  //   time: timeGetter(),
  // };
  const isReply = decodedToken.isReply;
  // A message id string, or {type, id} for a reply to a post / moment /
  // thought - validated here so a malformed object is a 400, not a stored
  // document every reader has to survive.
  const replyingTo = sanitizeIncomingReplyingTo(decodedToken.replyingTo);
  // A reply to a moment/thought/post: it must still be there, visible to the
  // sender, and - for a moment or thought - taking replies.
  await assertCanReplyTo(replyingTo, entity_id);
  const messageType = decodedToken.messageType;
  const conversationType = normalizeConversationType(
    decodedToken.conversationType,
  );

  const sanitizedContent = sanitizeForStorage(content);

  // What the conversation list and the push show for this message. The text
  // itself, or - for a post sent into the chat without a note - a line saying
  // so ("Sent a post"), where both would otherwise be blank. Never stored as
  // the message's content.
  const previewText =
    String(decodedToken.messageType) === POST_MESSAGE_TYPE
      ? POST_MESSAGE_PREVIEW
      : sanitizedContent || replyPreviewLabel(replyingTo) || "";

  // Parsed once, used twice: the realtime frame tells every bot a command
  // was typed, and queueCommand runs the ones that are the platform's.
  // Parsing in both places would be a second chance for them to disagree
  // about what was said.
  const typedCommand =
    String(messageType).toLowerCase() === "text"
      ? parseCommand(sanitizedContent)
      : null;

  const payload = {
    messageID: messageID,
    conversationID: conversationID,
    pendingID: pendingID,
    sender: sender,
    receivers: [], // receivers
    seeners: seeners,
    content: sanitizedContent,
    // messageDate: messageDate,
    isReply: isReply,
    replyingTo: replyingTo,
    reactions: [],
    isDeleted: false,
    messageType: messageType,
    conversationType: conversationType,
  };

  const newMessage = new UserMessage(payload);

  // The save and the two conversation writes after it were one promise chain
  // with one catch before this was a function, answering "Error checking
  // message" for a failure in any of the three - kept as one unit here.
  try {
    await newMessage.save();

    // Context only - see queueMessageTagging. Never awaited: sending a
    // message must not wait on content analysis.
    queueMessageTagging({
      messageID,
      conversationID,
      sender,
      content: sanitizedContent,
      messageType,
    });

    await ChatHistory.updateMany(
      {
        conversationID: conversationID,
      },
      {
        $set: {
          isArchived: false,
        },
      },
    );

    await SaveConversation(
      conversationID,
      conversationType,
      "user",
      null,
      receivers,
      messageID,
      sender,
      previewText,
      new Date(),
      messageType,
      false,
    );
  } catch (err) {
    console.log(err);
    err.saveFailed = true;
    throw err;
  }

  // Everything below ran after the response before this was a function, and
  // still does: the caller has its answer the moment the conversation is
  // updated. Never awaited, so a failure here is logged and never surfaces as
  // a failed send.
  const afterSend = async () => {
    receivers.map((rcvs, i) => {
      const isMentioned = mentionedReceiverSet.has(rcvs);

      MessagesTrigger(
        rcvs,
        {
          conversationID,
          entityID: sender,
          mentioner: isMentioned ? mentioner : null,
          // A bot learns about a command the way it learns about a
          // mention: from the frame. Name and target only - enough to
          // decide whether it has this command, and not enough to act
          // without reading the message, which it does anyway.
          //
          // Sent to EVERY recipient rather than only to bots that own
          // the name: chatterloop does not know what an external bot
          // answers to, and deciding is the bot's business.
          command: typedCommand
            ? { name: typedCommand.name, target: typedCommand.target }
            : null,
        },
        false,
      );
    });
    // A /command, if this message is one. Same contract as
    // queueMessageTagging: never awaited, never throws.
    //
    // QUEUED LAST, AND THAT ORDER IS LOAD-BEARING
    // -------------------------------------------
    // worker_service answers a command by writing a message of its own,
    // and it starts the moment this is published. Queued any earlier, it
    // races the three writes above and loses in all three ways:
    //
    //   SaveConversation had not run, so the `conversations` document
    //   was missing or stale - and that document is where the worker
    //   reads the participants it announces the reply to. No
    //   participants, no frames, so the reply arrived for nobody until
    //   they refreshed.
    //
    //   SaveConversation would then OVERWRITE last_message with this
    //   message, so the chat list showed the command as the latest thing
    //   said even though the reply came after it.
    //
    //   MessagesTrigger had not run, so the answer was announced before
    //   the question - the reply appeared above a message that was not
    //   on screen yet.
    //
    // The message itself is saved well before this either way; it is the
    // writes AROUND it that the worker depends on.
    queueCommand({
      command: typedCommand,
      messageID,
      conversationID,
      conversationType,
      sender,
      senderHandle: mentionerDetails?.handle || username,
      content: sanitizedContent,
      messageType,
      // Message threading only: the command envelope carries a message
      // id, so a reply to a moment/post/thought reaches it as no reply.
      replyingTo: repliedMessageID(replyingTo),
      // What decides reach - a bot answers a command only in
      // conversations it belongs to.
      participants: receivers,
    });

    bumpChatScore(conversationID, receivers, entity_id);

    if (messageType === "text") {
      resolveLinkPreviewForMessage(
        messageID,
        conversationID,
        sanitizedContent,
        receivers,
        sender,
      );
    }

    const senderDetails = await GetSenderDetails(sender);

    // GetAllReceivers includes the sender, and their own other devices
    // would otherwise be notified of their own message.
    const pushReceivers = receivers.filter(
      (r) => String(r) !== String(entity_id),
    );

    // Anyone @mentioned gets the mention push INSTEAD of the plain
    // message push, not as well as it - two tray entries for one message
    // is noise, and the mention one is strictly more informative (it
    // carries the message text too, so nothing is lost by the swap).
    const mentionedPushReceivers = pushReceivers.filter((r) =>
      mentionedReceiverSet.has(r),
    );
    const plainPushReceivers = pushReceivers.filter(
      (r) => !mentionedReceiverSet.has(r),
    );

    if (mentionedPushReceivers.length > 0) {
      const mentionPreview =
        messageType === "text" && sanitizedContent
          ? `${mentioner.username} mentioned you: ${sanitizedContent}`
          : `${mentioner.username} mentioned you`;

      // sendActivity, not sendMessage: this rides the quieter Activity
      // channel, whose tone is notification_alert - the exact sound
      // webapp plays for a mention (reusables/hooks/sse.ts's mentioner
      // branch), and a channel whose description already names mentions.
      // The app renders any non-"message" type generically from
      // title/body/route, so this needs no mobile release
      // (chatterloop_app/lib/core/notifications/push_payload.dart).
      push.sendActivity({
        receivers: mentionedPushReceivers,
        type: "mention",
        // Titled like the message push - the group for a group, the
        // person for a single chat - so the two read consistently in
        // the tray. webapp folds the realm into its sentence instead
        // ("... mentioned you at X") because a toast has no title slot.
        title:
          decodedToken.conversationType !== "single"
            ? realmName
            : senderDetails?.display_name || `@${username}`,
        body: mentionPreview,
        route: `/conversation/${conversationID}`,
        senderAvatarUrl: senderDetails?.profile || "",
      });
    }

    push.sendMessage({
      receivers: plainPushReceivers,
      conversationId: conversationID,
      // Which chat this is, NOT who sent it (senderName carries that).
      // A group is titled by the group; a single chat by the person.
      // realmName is null for singles by construction above, so the two
      // arms can't be swapped without the single case losing its title.
      conversationName:
        decodedToken.conversationType !== "single"
          ? realmName
          : senderDetails?.display_name || `@${username}`,
      isGroup: decodedToken.conversationType !== "single",
      senderId: entity_id,
      senderName: senderDetails?.display_name || `@${username}`,
      senderAvatarUrl: senderDetails?.profile || "",
      body:
        messageType === "text" || messageType === POST_MESSAGE_TYPE
          ? previewText
          : "Sent an attachment",
      messageId: messageID,
    });
  };

  afterSend().catch((err) => {
    console.log(err);
  });

  return { pendingID, messageID };
};

router.post(
  "/sendMessage",
  jwtchecker,
  requiresPermission("messages.send"),
  async (req, res) => {
    try {
      const decodedToken = jwt.verify(req.body.token, JWT_SECRET);
      const { pendingID } = await deliverMessage(req.params, decodedToken);

      res.send({
        status: true,
        message: "Message Sent",
        pendingID: pendingID,
      });
    } catch (ex) {
      console.log(ex);
      if (ex.saveFailed) {
        return res.send({ status: false, message: "Error checking message" });
      }
      res
        .status(400)
        .send({ status: false, message: ex.message || ex.toString() });
    }
  },
);

// How many destinations one "Send in message" may reach.
const SEND_POST_MAX_CONVERSATIONS = 10;

const cleanProfile = (profile) =>
  profile && profile !== "none" && profile !== "N/A" ? profile : null;

/**
 * The conversationType of a group or channel conversation the sender picked:
 * from its conversation document when there is one, else from the realm it
 * belongs to (a group's or channel's conversationID IS its realm_id, and a
 * channel is a realm with a parent server). Null when it is neither.
 */
const conversationTypeOf = async (conversationID) => {
  const doc = await Conversations.findOne(
    { conversationID },
    { conversationType: 1 },
  ).lean();
  if (doc?.conversationType) return doc.conversationType;

  const { rows } = await pool.query(
    `SELECT type, parent_id FROM community_realm WHERE realm_id = $1 AND is_active = TRUE`,
    [conversationID],
  );
  if (!rows[0]) return null;
  return rows[0].parent_id ? "channel" : rows[0].type;
};

/**
 * "Send in message": sends a post to up to SEND_POST_MAX_CONVERSATIONS
 * destinations, each either
 *
 *   {kind: "entity", id}        a person or a page - through the SAME
 *                               find-or-create as /m/crtc, so it reaches
 *                               anyone, not only people you already have a
 *                               conversation with;
 *   {kind: "conversation", id}  a group chat or a server channel you are in.
 *
 * Each is an ordinary message through deliverMessage (text, the optional note
 * as its content) whose replyingTo is {type: "post", id} - so the chat shows
 * the post as a reply card, hydrated per reader by replyTargets.js.
 *
 * It is a SHARE: one ranking bump, one interaction bump towards the author and
 * one engagement row (via "message") per send, however many chats it reached,
 * so sending to ten cannot count ten times. No notification to the author -
 * unlike a repost, this is a private share.
 *
 * Signed payload: { postID, targets: [{kind, id}], content?: note }
 * (`conversationIDs: [..]` is still accepted, as conversation targets.)
 * Answers with the outcome per target; `status` is true if at least one went
 * through.
 */
router.post(
  "/sendPost",
  jwtchecker,
  requiresPermission("messages.send"),
  async (req, res) => {
    const entity_id = req.params.entity_id;

    try {
      const decodedToken = jwt.verify(req.body.token, JWT_SECRET);
      const postID = String(decodedToken.postID || "");
      const note =
        typeof decodedToken.content === "string" ? decodedToken.content : "";

      const rawTargets = [
        ...(Array.isArray(decodedToken.targets) ? decodedToken.targets : []),
        ...(Array.isArray(decodedToken.conversationIDs)
          ? decodedToken.conversationIDs.map((id) => ({
              kind: "conversation",
              id,
            }))
          : []),
      ];
      const seen = new Set();
      const targets = rawTargets
        .filter(
          (target) =>
            target &&
            (target.kind === "entity" || target.kind === "conversation") &&
            target.id,
        )
        .map((target) => ({ kind: target.kind, id: String(target.id) }))
        .filter((target) => {
          const key = `${target.kind}:${target.id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

      if (!postID) {
        return res
          .status(400)
          .send({ status: false, message: "No post to send" });
      }
      if (targets.length === 0) {
        return res
          .status(400)
          .send({ status: false, message: "Choose at least one recipient" });
      }
      if (targets.length > SEND_POST_MAX_CONVERSATIONS) {
        return res.status(400).send({
          status: false,
          message: `A post can be sent to at most ${SEND_POST_MAX_CONVERSATIONS} chats at once`,
        });
      }

      // The sender must be able to read the post themselves, and it must
      // still be live. 404 for all of it: whether a post they cannot see
      // exists is not something to confirm.
      const { rows: postRows } = await pool.query(
        `
        SELECT p.entity_id, p.on_feed
        FROM newsfeed_post p
        WHERE p.post_id = $1
          AND p.deleted_at IS NULL
          AND (p.expires_at IS NULL OR p.expires_at > now())
          AND (p.is_archived = FALSE OR p.entity_id = $2)
          AND ${postVisibleToSQL("p", "$2")}
        LIMIT 1;
        `,
        [postID, String(entity_id)],
      );

      if (postRows.length === 0) {
        return res
          .status(404)
          .send({ status: false, message: "Post not available" });
      }

      const authorID = String(postRows[0].entity_id);
      const kind = postRows[0].on_feed;
      const targetType =
        kind === POST_KINDS.MOMENT || kind === POST_KINDS.THOUGHT
          ? kind
          : "post";

      // One at a time, in the order chosen: a handful of sends, and each
      // resolves as soon as its message is stored.
      const results = [];
      for (const target of targets) {
        // Known up front for a group/channel; found or made for a person.
        let conversationID = target.kind === "conversation" ? target.id : null;
        try {
          let conversationType;
          if (target.kind === "entity") {
            ({ conversationID } = await findOrCreateDirectConversation(
              entity_id,
              target.id,
            ));
            conversationType = "single";
          } else {
            conversationType = await conversationTypeOf(conversationID);
            if (!conversationType) {
              results.push({
                ...target,
                conversationID,
                status: false,
                message: "Chat not found",
              });
              continue;
            }
          }

          // With a note it is a REPLY to the post (the note is the text);
          // without one it is simply a post message - messageType "post",
          // the post id as its content, like a photo's url - rather than an
          // empty text reply.
          const hasNote = !!String(note || "").trim();
          const { messageID } = await deliverMessage(
            req.params,
            hasNote
              ? {
                  pendingID: null,
                  conversationID,
                  conversationType,
                  content: note,
                  messageType: "text",
                  isReply: true,
                  replyingTo: { type: targetType, id: postID },
                }
              : {
                  pendingID: null,
                  conversationID,
                  conversationType,
                  content: postID,
                  messageType: POST_MESSAGE_TYPE,
                  isReply: false,
                  replyingTo: "",
                },
          );
          results.push({ ...target, conversationID, status: true, messageID });
        } catch (err) {
          results.push({
            ...target,
            conversationID,
            status: false,
            message: err.saveFailed
              ? "Error sending message"
              : err.message || "Could not send to this chat",
          });
        }
      }

      const sent = results.filter((result) => result.status).length;

      if (sent > 0) {
        updateRankingScore(postID, "share", false);
        if (authorID !== String(entity_id)) {
          interactionScoreBump(entity_id, authorID, "SHARE", false);
        }
        logPostShare(entity_id, postID, "message", { conversations: sent });
      }

      res.send({ status: sent > 0, result: { sent, results } });
    } catch (ex) {
      console.log(ex);
      res
        .status(400)
        .send({ status: false, message: ex.message || ex.toString() });
    }
  },
);

/**
 * Who "Send in message" can send to, in three sections (all filtered by `q`):
 *
 *   direct    people and pages. Without `q`, the ones you chatted with most
 *             recently; with `q`, ANYONE matching - you do not need an
 *             existing chat, sendPost opens one like /m/crtc.
 *   groups    group chats you are a member of.
 *   channels  server channels you are a member of, labelled with their server.
 *
 * GET /u/sendPostTargets?q=  ->  { direct, groups, channels }
 */
router.get("/sendPostTargets", jwtchecker, async (req, res) => {
  const entity_id = String(req.params.entity_id);
  const q = String(req.query.q || "").trim();
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

  try {
    // ── Direct: people and pages ──
    let directIDs = [];
    if (q) {
      const { rows } = await pool.query(
        `
        SELECT entity_id FROM (
          SELECT ua.entity_id, ua.username AS handle,
                 TRIM(CONCAT(ua.first_name, ' ', ua.last_name)) AS name
          FROM user_account ua
          WHERE ua.is_active = TRUE AND ua.is_verified = TRUE
          UNION ALL
          SELECT r.entity_id, r.slug AS handle, r.name
          FROM community_realm r
          WHERE r.type = 'page' AND r.is_active = TRUE
        ) people
        WHERE entity_id <> $1
          AND (name ILIKE $2 OR handle ILIKE $2)
          AND NOT EXISTS (
            SELECT 1 FROM entity_block b
            WHERE (b.blocker_id = $1 AND b.blocked_id = people.entity_id)
               OR (b.blocked_id = $1 AND b.blocker_id = people.entity_id)
          )
        ORDER BY (handle ILIKE $3) DESC, name
        LIMIT 20;
        `,
        [entity_id, like, `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`],
      );
      directIDs = rows.map((row) => String(row.entity_id));
    } else {
      const recent = await Conversations.find(
        {
          participant_ids: entity_id,
          conversationType: "single",
          last_message: { $ne: null },
        },
        { participant_ids: 1 },
      )
        .sort({ "last_message.messageDate": -1 })
        .limit(20)
        .lean();
      directIDs = [
        ...new Set(
          recent
            .map((doc) =>
              (doc.participant_ids || [])
                .map(String)
                .find((id) => id !== entity_id),
            )
            .filter(Boolean),
        ),
      ];
    }

    const handles = await GetEntityHandles(directIDs);
    const direct = directIDs
      .map((id) => {
        const found = handles.get(id);
        if (!found) return null;
        return {
          entity_id: id,
          type: found.entity_type,
          display_name: found.display_name || found.handle || "",
          handle: found.handle || "",
          profile: cleanProfile(found.profile),
        };
      })
      .filter(Boolean);

    // ── Groups and channels you are a member of ──
    const { rows: realms } = await pool.query(
      `
      SELECT r.realm_id, r.name, r.slug, r.profile, r.type, r.parent_id,
             s.name AS server_name, s.profile AS server_profile
      FROM community_member m
      JOIN community_realm r ON r.realm_id = m.realm_id AND r.is_active = TRUE
      LEFT JOIN community_realm s ON s.realm_id = r.parent_id
      WHERE m.entity_id = $1
        AND (r.type = 'group' OR r.parent_id IS NOT NULL)
        AND ($2 = '' OR r.name ILIKE $3 OR s.name ILIKE $3)
      ORDER BY s.name NULLS FIRST, r.name
      LIMIT 100;
      `,
      [entity_id, q, like],
    );

    const groups = realms
      .filter((realm) => !realm.parent_id)
      .map((realm) => ({
        conversation_id: realm.realm_id,
        display_name: realm.name || realm.slug || "",
        profile: cleanProfile(realm.profile),
      }));
    const channels = realms
      .filter((realm) => realm.parent_id)
      .map((realm) => ({
        conversation_id: realm.realm_id,
        display_name: realm.name || realm.slug || "",
        server_name: realm.server_name || "",
        server_profile: cleanProfile(realm.server_profile),
      }));

    res.send({ status: true, result: { direct, groups, channels } });
  } catch (err) {
    console.log(err);
    res
      .status(400)
      .send({ status: false, message: "Couldn't load who you can send to" });
  }
});

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

router.get("/initConversationList", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const page = req.headers["page"];
  const range = req.headers["range"];
  const type = req.headers["type"] || "all";

  const contacts = await GetListOfContactsV2(userID);
  const realmsJoined = await GetRealmsJoined(userID);
  const conversationIDs = [...contacts, ...realmsJoined];

  const typeSetup = {
    common: ["group", "single"],
    servers: ["channel"],
    groups: ["group"],
    direct: ["single"],
    conference: ["conference"],
  };

  const match = {
    conversationID: { $in: conversationIDs },
  };

  if (type !== "all") {
    const typeArray = typeSetup[type];

    if (typeArray) {
      match.conversationType = { $in: typeArray };
    }
  }

  await UserMessage.aggregate([
    {
      $match: match,
    },
    // --- START OF NEW CODE: Filter out history cleared by this user ---
    {
      $lookup: {
        from: "chat_history", // Matches your explicit collection name
        let: { msg_conv_id: "$conversationID" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$conversationID", "$$msg_conv_id"] },
                  { $eq: ["$userID", userID] }, // Matches the current requesting user
                ],
              },
            },
          },
        ],
        as: "historySetting",
      },
    },
    {
      $unwind: {
        path: "$historySetting",
        preserveNullAndEmptyArrays: true, // Keeps the message intact if they have never cleared this chat
      },
    },
    {
      $match: {
        $expr: {
          $gt: [
            "$messageDate", // Matches your schema's date property name
            {
              $ifNull: [
                // Safe conversion check for string vs date objects
                {
                  $cond: {
                    if: {
                      $eq: [{ $type: "$historySetting.cleared_at" }, "string"],
                    },
                    then: {
                      $dateFromString: {
                        dateString: "$historySetting.cleared_at",
                      },
                    },
                    else: "$historySetting.cleared_at",
                  },
                },
                new Date(0), // Defaults to 1970 if cleared_at is null or missing
              ],
            },
          ],
        },
      },
    },
    // --- END OF NEW CODE ---
    {
      $match: {
        $expr: {
          $ne: [{ $ifNull: ["$historySetting.isArchived", false] }, true],
        },
      },
    },
    {
      $group: {
        _id: "$conversationID",
        sortID: { $last: "$_id" },
        conversationID: { $last: "$conversationID" },
        messageID: { $last: "$messageID" },
        sender: { $last: "$sender" },
        receivers: { $last: "$receivers" },
        seeners: { $last: "$seeners" },
        content: { $last: "$content" },
        messageDate: { $last: "$messageDate" },
        isReply: { $last: "$isReply" },
        // Stored as {type, id}; listed as the bare id clients have always
        // read (see LEGACY_REPLYING_TO_EXPR).
        replyingTo: { $last: LEGACY_REPLYING_TO_EXPR },
        reactions: { $last: "$reactions" },
        isDeleted: { $last: "$isDeleted" },
        messageType: { $last: "$messageType" },
        conversationType: { $last: "$conversationType" },
        unread: {
          $sum: {
            $cond: {
              if: {
                $in: [userID, "$seeners"],
              },
              then: 0,
              else: 1,
            },
          },
        },
      },
    },
    {
      $facet: {
        metadata: [{ $count: "total" }],
        data: [
          { $sort: { sortID: -1 } },
          { $skip: (parseInt(page) - 1) * parseInt(range) },
          { $limit: parseInt(range) },
          {
            $project: {
              "users.birthdate": 0,
              "users.dateCreated": 0,
              "users.email": 0,
              "users.gender": 0,
              "users.isActivated": 0,
              "users.isVerified": 0,
              "users.password": 0,
            },
          },
        ],
      },
    },
    {
      $project: {
        data: 1,
        total: { $ifNull: [{ $arrayElemAt: ["$metadata.total", 0] }, 0] }, // Fallback to 0 if metadata is empty
      },
    },
  ])
    .then(async (result_raw) => {
      const result = result_raw[0].data;
      const total = result_raw[0].total;
      const next = total - range * page > 0;
      const resultGroups = result.map((mp) => mp.conversationID);

      const flattenedGroupsArray = resultGroups.flat();

      const directConversations = result
        .filter((flt) => flt.conversationType === "single")
        .map((mp) => mp.conversationID);

      // GetUsersWithConnectionIDs now returns fully-resolved, entity-generic
      // participant info per conversation (users AND realms/pages), so this
      // list keeps user<->realm counterparts instead of dropping them.
      const usersWCns = await GetUsersWithConnectionIDs(directConversations);

      const usersByConversationID = {};

      for (const item of usersWCns) {
        usersByConversationID[item.conversationID] = item.users;
      }

      const { rows: group_rows } = await pool.query(
        `SELECT 
              json_build_object(
                '_id', cr.id,
                'serverID', cr.parent_id,
                'groupID', cr.realm_id,
                'profile', COALESCE(cr.profile, 'N/A'),
                'dateCreated', json_build_object(
                  'date', '',
                  'time', ''
                ),
                'createdBy', created_by.username,
                'type', cr.type,
                'privacy', cr.is_private,
                'groupName', cr.name
              ) AS groupdetails,
              
              CASE
                WHEN cr.parent_id IS NOT NULL THEN
                  json_build_object(
                    '_id', pr.id,
                    'serverID', pr.realm_id,
                    'serverName', pr.name,
                    'profile', COALESCE(pr.profile, 'N/A'),
                    'dateCreated', json_build_object(
                      'date', '',
                      'time', ''
                    ),
                    'members', (
                      SELECT COALESCE(json_agg(json_build_object('userID', a.username)), '[]'::json)
                      FROM community_member m
                      JOIN user_account a ON m.account_id = a.id
                      WHERE m.realm_id = pr.realm_id
                    ),
                    'createdBy', parent_created_by.username,
                    'privacy', pr.is_private
                  )
                ELSE NULL
              END AS serverdetails
            FROM community_realm cr
            LEFT JOIN community_realm pr ON cr.parent_id = pr.realm_id
            LEFT JOIN user_account created_by ON cr.created_by_id = created_by.id
            LEFT JOIN user_account parent_created_by ON pr.created_by_id = parent_created_by.id
            WHERE cr.realm_id = ANY($1);
            `,
        [flattenedGroupsArray],
      );

      const finalResult = result.map((mp) => {
        const involvedUsers = usersByConversationID[mp.conversationID] || [];

        const details = group_rows.filter(
          (flt) => flt.groupdetails.groupID === mp.conversationID,
        );
        const final_details = details.length > 0 ? details[0] : null;

        let final_mp = mp;

        if (final_details) {
          final_mp = removeNullServerDetails({
            ...final_mp,
            ...final_details,
          });
        }

        return {
          ...final_mp,
          content: final_mp.isDeleted ? "" : final_mp.content,
          users: involvedUsers,
        };
      });

      const finalResultWParticipants = await Promise.all(
        finalResult.map(async (mp) => ({
          ...mp,
          voice_participants: await getAllParticipants(mp.conversationID),
        })),
      );

      // console.log(result.reverse())
      const encodedResult = jwt.sign(
        {
          conversationslist: finalResultWParticipants,
          total,
          next,
        },
        JWT_SECRET,
        {
          expiresIn: 60 * 60 * 24 * 7,
        },
      );

      // res.send({ status: true, message: "OK", result: encodedResult });
      res.send({ status: true, message: "OK", result: encodedResult });
    })
    .catch((err) => {
      console.log(err);
      res.send({
        status: false,
        message: "Error generating conversations list",
      });
    });
});

router.get(
  "/initConversation/:conversationID",
  jwtchecker,
  async (req, res) => {
    const userID = req.params.userID;
    const entity_id = req.params.entity_id;
    const conversationID = req.params.conversationID;
    const page = req.headers["page"];
    const range = req.headers["range"];
    const totalmessages = await GetAllMessageCountInAConversation(
      entity_id,
      conversationID,
    );

    try {
      // isRealmMember covers both realm-backed (group/channel) conversations
      // and single/DM conversations (via entity_connection, or the Mongo
      // Conversations doc's participant_ids for connection-less
      // conversations) - was previously missing entirely for the single
      // case, letting any authenticated account load any conversationID's
      // full message history just by knowing its id.
      await isRealmMember(conversationID, entity_id);
    } catch (err) {
      return res.status(401).send({
        status: false,
        message: err.message || "You do not have access to this conversation",
      });
    }

    await UserMessage.aggregate([
      {
        $match: {
          conversationID: conversationID,
        },
      },
      // --- START OF NEW CODE: Filter out messages older than cleared_at ---
      {
        $lookup: {
          from: "chat_history", // Matches your chat history collection name
          let: { msg_conv_id: "$conversationID" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$conversationID", "$$msg_conv_id"] },
                    { $eq: ["$entityID", entity_id] }, // 'userID' of the requesting user
                  ],
                },
              },
            },
          ],
          as: "historySetting",
        },
      },
      {
        $unwind: {
          path: "$historySetting",
          preserveNullAndEmptyArrays: true, // Keep messages if they never cleared history
        },
      },
      {
        $match: {
          $expr: {
            $gt: [
              "$messageDate",
              {
                $ifNull: [
                  // Safely handles the date if it is stored as a string or a real Date object
                  {
                    $cond: {
                      if: {
                        $eq: [
                          { $type: "$historySetting.cleared_at" },
                          "string",
                        ],
                      },
                      then: {
                        $dateFromString: {
                          dateString: "$historySetting.cleared_at",
                        },
                      },
                      else: "$historySetting.cleared_at",
                    },
                  },
                  new Date(0),
                ],
              },
            ],
          },
        },
      },
      // --- END OF NEW CODE ---
      // `replyedmessage`: the quoted message, for either stored replyingTo
      // shape (bare id, or {type: "message", id}).
      REPLIED_MESSAGE_LOOKUP,
      {
        $project: {
          "reactionsWithInfo._id": 0,
          "reactionsWithInfo.birthdate": 0,
          "reactionsWithInfo.gender": 0,
          "reactionsWithInfo.email": 0,
          "reactionsWithInfo.password": 0,
          "reactionsWithInfo.dateCreated": 0,
        },
      },
      {
        // messageDate, NOT _id.
        //
        // An ObjectId is a 4-byte timestamp at ONE-SECOND resolution, then
        // five random bytes fixed per PROCESS, then a counter. Two documents
        // written in the same second by the same process order by the counter
        // - fine. Written in the same second by DIFFERENT processes they order
        // by those random bytes, which is arbitrary and, worse, stable:
        // whichever process drew the lower value always sorts first.
        //
        // Node writes a message and worker_service writes a command's reply
        // ~70ms later, so the two land in the same second nearly every time,
        // and the reply rendered above the command. It looked intermittent
        // only because a pair straddling a second boundary sorted correctly on
        // the timestamp bytes.
        //
        // messageDate is millisecond-resolution and written by whoever created
        // the message, so it orders across processes. _id stays as a tie-break
        // so the sort is total and $skip/$limit paging cannot shift rows
        // between pages.
        $sort: {
          messageDate: -1,
          _id: -1,
        },
      },
      {
        $skip: (parseInt(page) - 1) * parseInt(range),
      },
      {
        $limit: parseInt(range),
      },
    ])
      .then(async (result) => {
        const message = result.reverse();
        const flattenedUsersInReactions = message
          .map((mp) => {
            if (mp.reactions) {
              const reactionUsers = mp.reactions.map((mpp) => mpp.entityID);

              return reactionUsers;
            }
          })
          .flat();

        const removeDuplicateReactors = [...new Set(flattenedUsersInReactions)];

        // Reactors are ENTITIES - a page can react while switched to it - so
        // this resolves from entity_entity outward instead of user_account
        // only, which returned nothing for realm reactors and left them
        // nameless in the reactions list. A realm's name/slug is mapped onto
        // the same user-shaped keys the clients already read ('N/A' is the
        // middle-name sentinel they skip). Ids are cast to text because
        // user_account.id is a uuid while community_realm.id is not.
        const { rows } = await pool.query(
          `SELECT
              COALESCE(ua.id::text, r.id::text, b.id::text) AS _id,
              e.id AS "entityID",
              e.type AS "entityType",
              COALESCE(ua.username, r.slug, b.handle) AS username,
              COALESCE(ua.id::text, r.id::text, b.id::text) AS "userID",
              CASE
                WHEN e.type = 'realm' THEN json_build_object(
                  'firstName', r.name,
                  'middleName', 'N/A',
                  'lastName', ''
                )
                -- Without this a bot reactor falls to the ELSE, where ua is
                -- NULL - so all three name parts come back null and the
                -- clients render a literal "null" (they build the middle name
                -- through a template literal, which stringifies it). Same
                -- failure the group member list had.
                WHEN e.type = 'bot' THEN json_build_object(
                  'firstName', b.name,
                  'middleName', 'N/A',
                  'lastName', ''
                )
                ELSE json_build_object(
                  'firstName', ua.first_name,
                  'middleName', ua.middle_name,
                  'lastName', ua.last_name
                )
              END AS fullname,
              COALESCE(ua.profile, r.profile, b.profile, 'none') AS profile,
              COALESCE(ua.is_active, r.is_active, b.is_active, TRUE) AS "isActivated",
              COALESCE(ua.is_verified, r.is_verified, b.is_verified, FALSE) AS "isVerified"
            FROM entity_entity e
            LEFT JOIN user_account ua ON ua.entity_id = e.id AND e.type = 'user'
            LEFT JOIN community_realm r ON r.entity_id = e.id AND e.type = 'realm'
            LEFT JOIN bot_bot b ON b.entity_id = e.id AND e.type = 'bot'
            WHERE e.id = ANY($1);`,
          [removeDuplicateReactors],
        );

        const mutatedMessagesArray = message.map((mp) => {
          const messageDocument = mp;
          const reactions = mp.reactions;

          if (reactions) {
            if (reactions.length > 0) {
              // Drop unresolved reactors rather than leaving `undefined`
              // holes in the array - clients were filtering those out on
              // arrival, which is what the realm-reactor gap looked like.
              messageDocument.reactionsWithInfo = reactions
                .map((mp) => rows.find((flt) => flt.entityID === mp.entityID))
                .filter(Boolean);
            } else {
              messageDocument.reactionsWithInfo = [];
            }
          }

          messageDocument.content = mp.isDeleted ? "" : mp.content;

          return messageDocument;
        });

        // `replyedtarget` on every reply - messages, posts, moments and
        // thoughts alike. Live messages need nothing extra: MessagesTrigger
        // only announces the conversation, and the client reloads it here.
        await hydrateReplyTargets(mutatedMessagesArray, entity_id);

        // Stored as {type, id}; sent the way every installed app build reads
        // it - the replied-to message id, or "" (see legacyReplyingTo).
        // The quoted message inside replyedmessage too - it comes straight
        // from the lookup, stored shape and all.
        for (const message of mutatedMessagesArray) {
          message.replyingTo = legacyReplyingTo(message.replyingTo);
          for (const quoted of message.replyedmessage || []) {
            quoted.replyingTo = legacyReplyingTo(quoted.replyingTo);
          }
        }

        const encodedResult = jwt.sign(
          {
            messages: mutatedMessagesArray,
            total: totalmessages,
          },
          JWT_SECRET,
          {
            expiresIn: 60 * 60 * 24 * 7,
          },
        );

        res.send({
          status: true,
          message: "OK",
          result: encodedResult,
        });
      })
      .catch((err) => {
        console.log(err);
        res.send({ status: false, message: "Error generating conversation" });
      });
  },
);

const sendMessageInitForGC = async (
  convID,
  entityID,
  username,
  recs,
  message,
  type,
) => {
  const messageID = await checkExistingMessageID(makeID(30));
  const conversationID = convID;
  const sender = entityID;
  const receivers = recs; //Array
  const seeners = [entityID]; //Array
  // entityID is the ACTING entity, so a group created while switched to a
  // page must read as the page. `username` is the human behind it and stays
  // as the fallback. This text is STORED on the message, so it's what the
  // conversation shows, not just the notification.
  const creatorDetails = await GetSenderDetails(entityID);
  const creatorHandle = creatorDetails?.handle || username;
  const content = `${creatorHandle} ${message}`;
  const messageDate = {
    date: dateGetter(),
    time: timeGetter(),
  };
  const isReply = false;
  const messageType = "notif";
  const conversationType = normalizeConversationType(type);

  const payload = {
    messageID: messageID,
    conversationID: conversationID,
    sender: sender,
    receivers: receivers,
    seeners: seeners,
    content: content,
    // messageDate: messageDate,
    isReply: isReply,
    replyingTo: "",
    reactions: [],
    isDeleted: false,
    messageType: messageType,
    conversationType: conversationType,
  };

  const newMessage = new UserMessage(payload);

  newMessage
    .save()
    .then(async () => {
      await ChatHistory.updateMany(
        {
          conversationID: conversationID,
        },
        {
          $set: {
            isArchived: false,
          },
        },
      );

      await SaveConversation(
        conversationID,
        conversationType,
        "user",
        null,
        receivers,
        messageID,
        sender,
        content,
        new Date(),
        messageType,
        false,
      );

      receivers.map((rcvs, i) => {
        // var sseWithUserID = sseNotificationsWaiters[rcvs];
        MessagesTrigger(rcvs, { conversationID, entityID: sender }, false);
        ContactListTrigger(rcvs, `${creatorHandle} created a group chat`);
      });

      // Being added to a group is exactly the kind of thing you need to hear
      // about while the app is closed - without this, you'd only discover the
      // group on next launch. Body reuses `content`, the same text stored on
      // the message, so the push and the conversation can't disagree.
      // creatorDetails is already resolved above; no second lookup needed.
      push.sendMessage({
        receivers: receivers.filter((r) => String(r) !== String(sender)),
        conversationId: conversationID,
        conversationName: await GetRealmName(conversationID),
        isGroup: true,
        senderId: sender,
        senderName: creatorDetails?.display_name || `@${username}`,
        senderAvatarUrl: creatorDetails?.profile || "",
        body: content,
        messageId: messageID,
      });
    })
    .catch((err) => {
      console.log(err);
    });
};

router.post(
  "/createContactGroupChat",
  jwtchecker,
  requiresPermission("conversations.create"),
  async (req, res) => {
    const userID = req.params.userID;
    const entity_id = req.params.entity_id;
    const id = req.params.id;
    const username = req.params.username;
    const token = req.body.token;

    const client = await pool.getPool();

    try {
      const decodeToken = jwt.verify(token, JWT_SECRET);

      const contactID = await checkGroupID(`${makeID(20)}`);
      const otherUsers = decodeToken.otherUsers;
      const groupName = decodeToken.groupName;
      const privacy = decodeToken.privacy;
      const allReceivers = [entity_id, ...otherUsers];
      const userReceivers = allReceivers.map((alr, i) => ({
        entityID: alr,
      }));

      // Entity-generic: a page can be a group member too. The old
      // user_account-only lookup dropped every realm before it reached the
      // community_member insert. (Same fix as createRealmReusable below.)
      const { rows } = await client.query(
        `SELECT p.id AS entity_id
           FROM entity_entity p
          WHERE p.id = ANY($1)`,
        [userReceivers.map((mp) => mp.entityID)],
      );

      const insertValues = [];
      const params = [];
      let paramIndex = 1;

      rows.forEach(({ entity_id: accountId }) => {
        insertValues.push(
          `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`,
        );
        // member_id - generate UUID here or use a package during insert if your DB auto-generates
        params.push(uuidv4()); // use a UUID generator (e.g. 'uuid' library)
        params.push(accountId); // account FK
        params.push(contactID); // pass your realm ID here
        params.push(entity_id); // who added this member (account FK)
        params.push(new Date()); // date_joined or null as needed

        if (accountId === entity_id) {
          params.push("owner"); // member role
        } else {
          params.push("member"); // member role
        }
      });

      const realm_entity_id = await CreateEntity("realm");

      await client.query(
        `INSERT INTO community_realm (
      id, realm_id, name, profile, type, created_by_id, parent_id, is_active, is_private, is_verified, ranking_score, created_at, is_temporary, entity_id
      ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), false, $12
      )`,
        [
          contactID,
          contactID,
          groupName,
          "N/A",
          "group",
          entity_id,
          null,
          true,
          privacy,
          false,
          0,
          realm_entity_id,
        ],
      );

      await client.query(
        `
        INSERT INTO community_member (member_id, entity_id, realm_id, added_by_id, date_joined, role)
        VALUES ${insertValues.join(", ")}
      `,
        params,
      );

      await client.query("COMMIT");

      // Atomic upsert instead of an unawaited, unconditional .save() - same
      // fix as messages/index.js's ChatHistory creation, guarding against
      // duplicate chat_history rows (no unique index on conversationID+
      // entityID exists) that would later fan this conversation out into
      // multiple rows in the conversations list.
      await Promise.all(
        allReceivers.map((mp) =>
          ChatHistory.findOneAndUpdate(
            { conversationID: contactID, entityID: mp },
            {
              $setOnInsert: {
                conversationID: contactID,
                entityID: mp,
                cleared_at: null,
                isArchived: false,
                isRestricted: false,
              },
            },
            { upsert: true, new: true },
          ),
        ),
      );

      sendMessageInitForGC(
        contactID,
        entity_id,
        username,
        allReceivers,
        "created the group chat",
        "group",
      );

      res.send({ status: true, message: `You created a Group Chat` });
    } catch (ex) {
      await client.query("ROLLBACK");
      res.send({ status: false, message: "Group token encountered an error!" });
      console.log(ex);
    }
  },
);

const createRealmReusable = async (
  id,
  parentRealmID,
  realmID,
  realmName,
  realmProfile,
  realmCoverPhoto,
  realmDesc,
  entityID,
  userReceivers,
  privacyprop,
  type,
  email,
  slug,
  is_temporary,
  starts_at = null,
  expires_at = null,
) => {
  // const userID = userIDpass; entityID
  const profile = realmProfile || "N/A";

  const client = await pool.getPool();

  try {
    const contactID = realmID ?? (await checkGroupID(`${makeID(20)}`));
    const privacy = privacyprop;

    const allReceivers = userReceivers.map((mp) => mp.entityID);

    // Members are ENTITIES - a page can be a member of a group/server/channel
    // just as a person can (community_member.entity_id FKs entity_entity).
    // The previous user_account-only lookup silently dropped every realm in
    // userReceivers, so a page picked in the create modal simply never got a
    // community_member row. Anchoring on entity_entity and left-joining both
    // detail tables also gives a usable handle for either kind.
    const { rows } = await client.query(
      `SELECT
         p.id AS entity_id,
         COALESCE(u.id, r.id, b.id) AS id,
         -- realm_id as the last resort: slug is nullable, and a slugless
         -- realm creating a group would otherwise put NULL in the system
         -- message ("NULL created the group chat").
         COALESCE(u.username, r.slug, b.handle, r.realm_id) AS username
       FROM entity_entity p
       LEFT JOIN user_account u ON u.entity_id = p.id AND p.type = 'user'
       LEFT JOIN community_realm r ON r.entity_id = p.id AND p.type = 'realm'
       LEFT JOIN bot_bot b ON b.entity_id = p.id AND p.type = 'bot'
       WHERE p.id = ANY($1)`,
      [allReceivers],
    );

    const insertValues = [];
    const params = [];
    let paramIndex = 1;

    rows.forEach(({ entity_id: accountId }) => {
      insertValues.push(
        `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`,
      );
      // member_id - generate UUID here or use a package during insert if your DB auto-generates
      params.push(uuidv4()); // use a UUID generator (e.g. 'uuid' library)
      params.push(accountId); // account FK
      params.push(contactID); // pass your realm ID here
      params.push(entityID); // who added this member (account FK)
      params.push(new Date()); // date_joined or null as needed

      if (accountId === entityID) {
        params.push("owner"); // realm creator - full control, incl. delete/ownership transfer
      } else {
        params.push("member"); // member role
      }
    });

    const realm_entity_id = await CreateEntity("realm");

    await client.query(
      `INSERT INTO community_realm (
      id, realm_id, name, profile, type, created_by_id, parent_id, is_active, is_private, is_verified, cover_photo, description, email, slug, ranking_score, starts_at, expires_at, created_at, is_temporary, entity_id
      ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW(), $18, $19
      )`,
      [
        contactID,
        contactID,
        realmName,
        profile,
        type,
        id,
        parentRealmID,
        true,
        privacy,
        false,
        realmCoverPhoto,
        realmDesc,
        email,
        slug,
        0,
        starts_at,
        expires_at,
        is_temporary,
        realm_entity_id,
      ],
    );

    await client.query(
      `
        INSERT INTO community_member (member_id, entity_id, realm_id, added_by_id, date_joined, role)
        VALUES ${insertValues.join(", ")}
      `,
      params,
    );

    await client.query("COMMIT");

    // Realtime fan-out for the two structural changes a client cannot learn any
    // other way. Both are published AFTER the commit, so anything refetching on
    // them reads settled rows.
    //
    // A CHANNEL announces itself to everyone who can see it - which for a
    // public channel is every server member (createchannel passes
    // GetServerMembers) and for a private one is exactly its invitees. A TEXT
    // channel used to be announced only as a side effect of the system message
    // below, which raises `messages_list`, and both clients happen to refetch
    // their channel list on that. A VOICE room has no chat history to write a
    // system message into, so nothing was ever published for it and the room
    // only turned up on somebody else's next manual refresh.
    //
    // A SERVER announces itself as a membership change, which is what puts it
    // in the creator's - and any invitee's - rail without them refetching.
    try {
      if (parentRealmID && (type === "channel" || type === "voice")) {
        allReceivers.forEach((rcp) => {
          publish(`events_${rcp}`, "server_channels_changed", {
            status: true,
            auth: true,
            message: `Channel created in ${parentRealmID}`,
            result: {
              realm_id: parentRealmID,
              channel_id: contactID,
              type,
            },
          });
        });
      }

      if (type === "server") {
        allReceivers.forEach((rcp) => {
          publish(`events_${rcp}`, "realm_membership_changed", {
            status: true,
            auth: true,
            message: `Server ${contactID} created`,
            result: {
              realm_id: contactID,
              type: "server",
              action: "joined",
              entity_ids: allReceivers,
            },
          });
        });
      }
    } catch (publishErr) {
      console.log("Failed to broadcast realm creation:", publishErr);
    }

    if (type !== "server" && type !== "voice" && type !== "page") {
      // Optional-chained: this used to index [0] unguarded, so it threw
      // whenever the creator wasn't in `rows` - which was ALWAYS the case
      // when creating while acting as a page, since the old lookup only
      // returned user_account rows. The entity-generic query above now
      // resolves a realm creator too (slug as the handle), but the fallback
      // keeps realm creation from dying on a system message if the creator
      // somehow isn't among the receivers.
      const creatorHandle =
        rows.filter((mp) => mp.entity_id === entityID)[0]?.username ?? "";

      sendMessageInitForGC(
        contactID,
        entityID,
        creatorHandle,
        allReceivers,
        `created the ${type === "group" ? "group chat" : type}`,
        type,
      );
    }
  } catch (ex) {
    await client.query("ROLLBACK");
    console.log(ex);
  }
};

router.post("/createchannel", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const id = req.params.id;
  const entityID = req.params.entity_id;
  const token = req.body.token;

  try {
    const decodedToken = jwt.verify(token, JWT_SECRET);
    const serverID = decodedToken.serverID;
    const memberstoadd = decodedToken.otherUsers;
    const privacy = decodedToken.privacy;
    const type = decodedToken.type; // channel or voice
    const groupName = decodedToken.groupName;

    const allReceivers = [entityID, ...memberstoadd];
    const userReceivers = allReceivers.map((alr, i) => ({
      entityID: alr,
    }));

    if (!(await hasPermission(entityID, "realm.channel.create", serverID))) {
      return res.status(403).send({
        status: false,
        message: "You are not allowed to create channels in this server.",
      });
    }

    const serverMembers = await GetServerMembers(serverID, false);

    if (privacy) {
      createRealmReusable(
        entityID,
        serverID,
        null,
        groupName,
        null,
        null,
        null,
        entityID,
        userReceivers,
        privacy,
        type, // "channel"
        null,
        null,
        false,
      );
    } else {
      createRealmReusable(
        entityID,
        serverID,
        null,
        groupName,
        null,
        null,
        null,
        entityID,
        serverMembers,
        privacy,
        type, // "channel"
        null,
        null,
        false,
      );
    }

    res.send({ status: true, message: "OK" });
  } catch (ex) {
    console.log(ex);
    res.send({ status: false, message: "Error decoding token" });
  }
});

router.post(
  "/createserver",
  jwtchecker,
  requiresPermission("realm.server.create"),
  async (req, res) => {
    const userID = req.params.userID;
    const id = req.params.id;
    const entityID = req.params.entity_id;
    const token = req.body.token;

    try {
      const decodeToken = jwt.verify(token, JWT_SECRET);
      const defaultchannellist = ["General", "Announcements", "Random"];

      const serverID = await checkGroupID(`${makeID(20)}`);
      const otherUsers = decodeToken.otherUsers;
      const serverName = decodeToken.groupName;
      const privacy = decodeToken.privacy;
      const allReceivers = [entityID, ...otherUsers];
      const userReceivers = allReceivers.map((alr, i) => ({
        entityID: alr,
      }));

      createRealmReusable(
        entityID,
        null,
        serverID,
        serverName,
        null,
        null,
        null,
        entityID,
        userReceivers,
        privacy,
        "server",
        null,
        null,
        false,
      );

      defaultchannellist.map((mp) => {
        createRealmReusable(
          entityID,
          serverID,
          null,
          mp,
          null,
          null,
          null,
          entityID,
          userReceivers,
          false,
          "channel",
          null,
          null,
          false,
        );
      });
      res.send({ status: true, message: `You created a Group Chat` });
    } catch (ex) {
      res.send({ status: false, message: "Group token encountered an error!" });
      console.log(ex);
    }
  },
);

router.post("/createconference", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const entityID = req.params.entity_id;
  const id = req.params.id;
  const token = req.body.token;

  try {
    const decodeToken = jwt.verify(token, JWT_SECRET);
    const conferenceTitle = decodeToken.groupName || "Conference";
    const privacy = decodeToken.privacy ?? false;
    const otherUsers = Array.isArray(decodeToken.otherUsers)
      ? decodeToken.otherUsers
      : [];
    const inviteTargets = Array.isArray(decodeToken.invitees)
      ? decodeToken.invitees
      : [];
    const conferenceID = await checkGroupID(`${makeID(20)}`);
    const startsAt =
      decodeToken.starts_at != null ? new Date(decodeToken.starts_at) : null;
    const expiresAt =
      decodeToken.expires_at != null ? new Date(decodeToken.expires_at) : null;
    const normalizedInviteTargets = inviteTargets
      .map((invite) => {
        const inviteObject =
          typeof invite === "string" ? { target_email: invite } : invite || {};
        const targetEmail = String(
          inviteObject.target_email ?? inviteObject.email ?? "",
        )
          .trim()
          .toLowerCase();

        if (!targetEmail) {
          return null;
        }

        return {
          id: inviteObject.id ?? null,
          realm_type: inviteObject.realm_type ?? "conference",
          kind: inviteObject.kind === "request" ? "request" : "invite",
          status: inviteObject.status ?? "pending",
          target_email: targetEmail,
          target_user_id: inviteObject.target_user_id ?? null,
          accepted_by_user_id: inviteObject.accepted_by_user_id ?? null,
          invite_token: inviteObject.invite_token ?? null,
          created_by: inviteObject.created_by ?? userID,
          created_at: inviteObject.created_at ?? null,
          resolved_at: inviteObject.resolved_at ?? null,
        };
      })
      .filter(Boolean);

    const inviteEmailList = normalizedInviteTargets.map(
      (invite) => invite.target_email,
    );
    const inviteAccounts = inviteEmailList.length
      ? await pool.query(
          `
            SELECT id, email, entity_id
            FROM user_account
            WHERE LOWER(email) = ANY($1::text[])
          `,
          [inviteEmailList],
        )
      : { rows: [] };
    const inviteAccountMap = new Map(
      inviteAccounts.rows.map((mp) => [
        String(mp.email).trim().toLowerCase(),
        mp.entity_id,
      ]),
    );
    const resolvedInvites = normalizedInviteTargets.map((invite, index) => ({
      id: invite.id ?? `INV_${makeID(12)}_${index}`,
      realm_id: conferenceID,
      realm_type: invite.realm_type ?? "conference",
      kind: invite.kind,
      status: invite.status,
      target_email: invite.target_email,
      target_entity_id:
        invite.target_entity_id ?? inviteAccountMap.get(invite.target_email),
      accepted_by_entity_id: invite.accepted_by_entity_id ?? null,
      invite_token: invite.invite_token ?? `${makeID(12)}`,
      created_by: invite.created_by ?? userID,
      created_at: invite.created_at ?? new Date().toISOString(),
      resolved_at: invite.resolved_at ?? null,
    }));

    const conferenceSlug = await checkConferenceSlug(`${makeID(6)}`);
    const allReceivers = [entityID, ...otherUsers];
    const userReceivers = allReceivers.map((alr) => ({
      entityID: alr,
    }));

    await createRealmReusable(
      entityID,
      null,
      conferenceID,
      conferenceTitle,
      null,
      null,
      null,
      entityID,
      userReceivers,
      privacy,
      "conference",
      null,
      conferenceSlug,
      true,
      startsAt && !isNaN(startsAt.getTime()) ? startsAt : null,
      expiresAt && !isNaN(expiresAt.getTime()) ? expiresAt : null,
    );

    res.send({
      status: true,
      message: "Conference has been created",
      result: {
        slug: conferenceSlug,
        realm_id: conferenceID,
        invites: resolvedInvites,
      },
    });
  } catch (ex) {
    res.send({
      status: false,
      message: "Conference token encountered an error!",
    });
    console.log(ex);
  }
});

router.post("/createpage", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const id = req.params.id;
  const entityID = req.params.entity_id;

  new multiparty.Form().parse(req, async (err, fields, files) => {
    if (err) return res.status(500).json({ error: err.message });

    try {
      const decodeToken = fields;

      const pageID = await checkGroupID(`${makeID(20)}`);
      const otherUsers = decodeToken.otherUsers
        ? JSON.parse(decodeToken.otherUsers[0])
        : [];
      const pageName = decodeToken.pageName[0];
      const pageDescription = decodeToken.pageDescription[0];
      const email = decodeToken.email[0];
      const slug = decodeToken.slug[0];
      const allReceivers = [entityID, ...otherUsers];
      const userReceivers = allReceivers.map((alr, i) => ({
        entityID: alr,
      }));

      const { rows } = await pool.query(
        `
        SELECT EXISTS (
          SELECT 1 FROM user_account WHERE username = $1
          UNION ALL
          SELECT 1 FROM community_realm WHERE slug = $1
        ) as slug_exists
      `,
        [slug],
      );

      const exists = rows[0]?.slug_exists ?? false;

      if (exists) {
        return res
          .status(409)
          .json({ status: false, error: "page username already taken" });
      }

      const profile = files.profile[0].path;
      const cover_photo = files.cover_photo[0].path;
      const profileBuffer = await fs.readFile(profile);
      const coverPhotoBuffer = await fs.readFile(cover_photo);

      // const finaluploadedreferences =
      //   await uploadFirebaseMultiple(filereferences);

      const profileUpload = await Storage.upload(
        entityID,
        profileBuffer,
        `${makeID(10)}_${files.profile[0].originalFilename}`,
        {
          referenceIDs: [entityID, id],
          action: "profile",
        },
        `uploads/pages/${pageID}`,
      );
      const coverPhotoUpload = await Storage.upload(
        entityID,
        coverPhotoBuffer,
        `${makeID(10)}_${files.cover_photo[0].originalFilename}`,
        {
          referenceIDs: [entityID, id],
          action: "cover_photo",
        },
        `uploads/pages/${pageID}`,
      );

      if (coverPhotoUpload && profileUpload) {
        createRealmReusable(
          entityID,
          null,
          pageID,
          pageName,
          profileUpload.fileDetails.data,
          coverPhotoUpload.fileDetails.data,
          pageDescription,
          entityID,
          userReceivers,
          false,
          "page",
          email,
          slug,
          false,
        );

        res.send({ status: true, message: `Page has been created` });
      } else {
        throw new Error("Error occured during upload");
      }
    } catch (ex) {
      res
        .status(500)
        .send({ status: false, message: ex.message || ex.toString() });
      console.log(ex);
    }
  });
});

router.post("/seenNewMessages", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const entityID = req.params.entity_id;
  const token = req.body.token;
  const range = req.headers["range"];

  // console.log("Seen", range);

  try {
    const decodeToken = jwt.verify(token, JWT_SECRET);

    const conversationID = decodeToken.conversationID;
    const messageIDs = decodeToken.messageIDs;
    const receiversfetch = await GetAllReceivers(conversationID);
    const receivers = receiversfetch.users.map((mp) => mp.entityID); //Array decodedToken.receivers
    // const receivers = decodeToken.receivers;

    UserMessage.updateMany(
      {
        conversationID: conversationID,
        messageID: { $in: messageIDs },
        // seeners: {
        //   $nin: [userID],
        // },
      },
      {
        $addToSet: { seeners: entityID },
        // $push: {
        //   seeners: userID,
        // },
      },
    )
      .then(async (result) => {
        if (result.modifiedCount > 0) {
          await SyncConversationLastMessage(conversationID)
            .then(() => {
              receivers.map((rcvs, i) => {
                MessagesTrigger(rcvs, { conversationID, entityID }, true);
              });
            })
            .catch((err) => {
              console.log(err);
            });
        }
        res.send({ status: true, message: "Seen OK", seen: messageIDs });
      })
      .catch((err) => {
        console.log(err);
        res
          .status(400)
          .send({ status: false, message: "Cannot update seen status" });
      });
  } catch (ex) {
    console.log(ex);
    res.status(500).send({ status: false, message: "Error reading messages!" });
  }
});

const checkExistingFileID = async (checkID) => {
  return await UploadedFiles.find({ fileID: checkID })
    .then((result) => {
      if (result.length > 0) {
        checkExistingFileID(`FILE_${makeID(20)}`);
      } else {
        return checkID;
      }
    })
    .catch((err) => {
      console.log(err);
      return false;
    });
};

const uploadMessage = async (
  mp,
  entityID,
  conversationID,
  receivers,
  isReply,
  replyingTo,
  conversationType,
  onComplete,
) => {
  try {
    var messageID = await checkExistingMessageID(makeID(30));

    // const publicUrl = await uploadFirebase(mp);
    const publicUrl = await Storage.uploadBase64(
      messageID,
      mp.reference,
      mp.name,
      {
        referenceIDs: [messageID, mp.conversationID],
        action: "message",
      },
      `uploads/messages/${conversationID}`,
    );

    await saveFileMessage(
      entityID,
      messageID,
      mp.pendingID,
      mp.conversationID,
      receivers,
      publicUrl,
      isReply,
      replyingTo,
      mp.type,
      conversationType,
      onComplete,
    );

    // await saveFileRecordToDatabase(
    //   [messageID, mp.conversationID],
    //   publicUrl,
    //   "message",
    //   mp.type,
    //   "firebase",
    //   mp.name,
    // );
  } catch (err) {
    console.log(err);
    onComplete(false);
  }
};

const saveFileMessage = async (
  entityID,
  messageID,
  pendingID,
  conversationID,
  receivers,
  content,
  isReply,
  replyingTo,
  messageType,
  conversationType,
  onComplete,
) => {
  // const seeners = [entityID]; //Array
  const seeners = [entityID]; //Array
  // const messageDate = {
  //   date: dateGetter(),
  //   time: timeGetter(),
  // };

  const normalizedConversationType =
    normalizeConversationType(conversationType);

  const payload = {
    messageID: messageID,
    conversationID: conversationID,
    pendingID: pendingID,
    sender: entityID,
    receivers: [], // receivers
    seeners: seeners,
    content: content,
    // messageDate: messageDate,
    isReply: isReply,
    replyingTo: replyingTo,
    reactions: [],
    isDeleted: false,
    messageType: messageType,
    conversationType: normalizedConversationType,
  };

  const newMessage = new UserMessage(payload);

  await newMessage
    .save()
    .then(async () => {
      // Context only - see queueMessageTagging.
      queueMessageTagging({
        messageID,
        conversationID,
        sender: entityID,
        content,
        messageType,
      });

      await ChatHistory.updateMany(
        {
          conversationID: conversationID,
        },
        {
          $set: {
            isArchived: false,
          },
        },
      );
      await SaveConversation(
        conversationID,
        normalizedConversationType,
        "user",
        null,
        receivers,
        messageID,
        entityID,
        content,
        new Date(),
        messageType,
        false,
      );
      onComplete(true);
    })
    .catch((err) => {
      onComplete(false);
      console.log(err);
    });
};

const uploadMessageFromFile = async (
  file,
  pendingID,
  entityID,
  conversationID,
  receivers,
  isReply,
  replyingTo,
  conversationType,
  onComplete,
) => {
  try {
    var messageID = await checkExistingMessageID(makeID(30));

    const buffer = await fs.readFile(file.path);
    const mimeType = file.headers["content-type"] || "application/octet-stream";
    const metadata = await Storage.upload(
      messageID,
      buffer,
      `${makeID(10)}_${file.originalFilename}`,
      {
        referenceIDs: [messageID, conversationID],
        action: "message",
      },
      `uploads/messages/${conversationID}`,
    );

    // Mirrors the client's existing type bucketing: images are tagged
    // "image", everything else keeps its real mime type.
    const messageType = mimeType.startsWith("image/") ? "image" : mimeType;

    await saveFileMessage(
      entityID,
      messageID,
      pendingID,
      conversationID,
      receivers,
      metadata.fileDetails.data,
      isReply,
      replyingTo,
      messageType,
      conversationType,
      onComplete,
    );

    fs.unlink(file.path).catch(() => {});
  } catch (err) {
    console.log(err);
    onComplete(false);
  }
};

router.post("/sendFiles", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const id = req.params.id;
  const entity_id = req.params.entity_id;

  const isMultipart = (req.headers["content-type"] || "").includes(
    "multipart/form-data",
  );

  if (isMultipart) {
    new multiparty.Form({ maxFilesSize: MAX_UPLOAD_FILE_SIZE }).parse(
      req,
      async (err, fields, files) => {
        if (err) {
          const isSizeErr = /maxFilesSize/i.test(err.message || "");
          res.status(isSizeErr ? 413 : 400).send({
            status: false,
            message: isSizeErr
              ? "File exceeds the maximum allowed size"
              : "Error processing upload",
            details: err.message,
          });
          return;
        }

        try {
          const conversationID = fields.conversationID?.[0];
          const isReply = fields.isReply?.[0] === "true";
          // Stored as {type, id} like every reply - see
          // sanitizeIncomingReplyingTo. "" when this is not a reply.
          const replyingTo = sanitizeIncomingReplyingTo(
            fields.replyingTo?.[0] || "",
          );
          const conversationType = normalizeConversationType(
            fields.conversationType?.[0],
          );
          const pendingIDs = fields.pendingIDs
            ? JSON.parse(fields.pendingIDs[0])
            : [];
          const attachedFiles = files.files || [];

          if (!conversationID || attachedFiles.length === 0) {
            res.status(400).send({
              status: false,
              message: "Missing conversationID or files",
            });
            return;
          }

          const receiversfetch = await GetAllReceivers(conversationID);
          const receivers = receiversfetch.users.map((mp) => mp.entityID);

          await isRealmMember(conversationID, entity_id);

          let settledFiles = 0;

          await Promise.allSettled(
            attachedFiles.map((file, i) =>
              uploadMessageFromFile(
                file,
                pendingIDs[i] || null,
                entity_id,
                conversationID,
                receivers,
                isReply,
                replyingTo,
                conversationType,
                (status) => {
                  settledFiles += 1;
                  if (attachedFiles.length === settledFiles) {
                    receivers.map((rcvs) => {
                      MessagesTrigger(
                        rcvs,
                        { conversationID, entityID: entity_id },
                        false,
                      );
                    });
                  }
                },
              ),
            ),
          );

          await ChatHistory.updateMany(
            { conversationID: conversationID },
            { $set: { isArchived: false } },
          );

          bumpChatScore(conversationID, receivers, entity_id);

          res.send({ status: true, message: "OK" });

          // Push AFTER res.send, so an FCM round trip can never delay the
          // upload response - and after Promise.allSettled, so a batch of
          // files produces one notification rather than one per file.
          const senderDetails = await GetSenderDetails(entity_id);
          const realmName =
            conversationType === "single"
              ? null
              : await GetRealmName(conversationID);

          push.sendMessage({
            receivers: receivers.filter((r) => String(r) !== String(entity_id)),
            conversationId: conversationID,
            conversationName:
              conversationType !== "single"
                ? realmName
                : senderDetails?.display_name || `@${req.params.username}`,
            isGroup: conversationType !== "single",
            senderId: entity_id,
            senderName:
              senderDetails?.display_name || `@${req.params.username}`,
            senderAvatarUrl: senderDetails?.profile || "",
            body:
              attachedFiles.length > 1
                ? `Sent ${attachedFiles.length} attachments`
                : "Sent an attachment",
          });
        } catch (ex) {
          console.log(ex);
          res
            .status(400)
            .send({ status: false, message: ex.message || ex.toString() });
        }
      },
    );
    return;
  }

  // Legacy signed-JWT base64 path - kept alive during rollout so older
  // frontend builds keep working; remove once all callers are confirmed
  // on multipart.
  const token = req.body.token;

  try {
    const decodeToken = jwt.verify(token, JWT_SECRET);

    const conversationID = decodeToken.conversationID;
    const receiversfetch = await GetAllReceivers(conversationID);
    const receivers = receiversfetch.users.map((mp) => mp.entityID); //Array decodedToken.receivers
    // const receivers = decodeToken.receivers;
    const files = decodeToken.files;
    const isReply = decodeToken.isReply;
    const replyingTo = sanitizeIncomingReplyingTo(decodeToken.replyingTo);
    const conversationType = normalizeConversationType(
      decodeToken.conversationType,
    );

    await isRealmMember(conversationID, entity_id);

    let settledFiles = 0;

    await Promise.allSettled(
      files.map((mp) => {
        uploadMessage(
          mp,
          entity_id,
          conversationID,
          receivers,
          isReply,
          replyingTo,
          conversationType,
          (status) => {
            settledFiles += 1;
            if (files.length === settledFiles) {
              receivers.map((rcvs, i) => {
                MessagesTrigger(
                  rcvs,
                  { conversationID, entityID: entity_id },
                  false,
                );
              });
            }
          },
        );
      }),
    );

    await ChatHistory.updateMany(
      {
        conversationID: conversationID,
      },
      {
        $set: {
          isArchived: false,
        },
      },
    );

    bumpChatScore(conversationID, receivers, entity_id);

    res.send({ status: true, message: "OK" });
  } catch (ex) {
    console.log(ex);
    res
      .status(400)
      .send({ status: false, message: ex.message || ex.toString() });
  }
});

router.post("/call", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const id = req.params.id;
  const entity_id = req.params.entity_id;
  const token = req.body.token;

  try {
    const decodeToken = jwt.verify(token, JWT_SECRET);
    const recepients = await GetAllReceivers(decodeToken.conversationID);

    await isRealmMember(decodeToken.conversationID, entity_id);

    recepients.users
      .filter((flt) => flt.entityID !== entity_id)
      .map((rcp) => {
        ReachCallRecepients(rcp.entityID, decodeToken);
      });

    res.send({ status: true, message: "OK" });
  } catch (ex) {
    console.log(ex);
    res
      .status(400)
      .send({ status: false, message: ex.message || ex.toString() });
  }
});

router.post("/notify-voice-join", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const entityID = req.params.entity_id;
  const username = req.params.username;
  const clientID = req.body.clientID;
  const profile = req.body.profile;
  // const recipients = req.body.recipients;
  const channelID = req.body.channelID;
  const instance = req.body.instance;

  const savedRecipients = await GetAllReceivers(channelID);
  const parsedSavedRecipients = savedRecipients.users.map((mp) => mp.entityID);

  const recipients = req.body.recipients
    ? [...req.body.recipients, ...parsedSavedRecipients, entityID]
    : [...parsedSavedRecipients, entityID];
  const uniqueRecipients = [...new Set(recipients)];

  try {
    uniqueRecipients.map((rcp) => {
      ReachVoiceRecepients(rcp, {
        entityID,
        username,
        profile,
        clientID,
        channelID,
        instance,
      });
    });

    addParticipant(channelID, {
      entityID,
      username,
      profile,
      clientID,
      channelID,
      instance,
    });

    res.send({ status: true, message: "OK" });
  } catch (ex) {
    console.log(ex);
    res.send({ status: false, message: "Error declaring call!" });
  }
});

const checkSessionID = async (currentID, deviceToken) => {
  return await UserSessions.find({
    sessionID: currentID,
    deviceToken: deviceToken,
  })
    .then((result) => {
      if (result.length > 0) {
        checkSessionID(
          `SESSION_${makeID(20)}_${dateGetter()}`
            .split(" ")
            .join("")
            .split(":")
            .join("_")
            .split("pm")
            .join("_")
            .split("/")
            .join("_"),
          deviceToken,
        );
      } else {
        return currentID;
      }
    })
    .catch((err) => {
      console.log(err);
      return false;
    });
};

const setUserSession = async (entityID, deviceToken, status, resolve) => {
  const newSessionID = await checkSessionID(
    `SESSION_${makeID(20)}_${dateGetter()}`
      .split(" ")
      .join("")
      .split(":")
      .join("_")
      .split("pm")
      .join("_")
      .split("/")
      .join("_"),
    deviceToken,
  );
  const newSessionPayload = {
    status: status,
    lastSeen: dateGetter(),
  };

  await UserSessions.updateOne(
    { entityID: entityID, deviceToken: deviceToken },
    newSessionPayload,
  )
    .then((_) => {
      resolve();
    })
    .catch((err) => {
      console.log(err);
    });
};

router.post("/coordinatesbroadcast", jwtchecker, async (req, res) => {
  const coordinates = req.body.coordinates;
  const receivers = req.body.receivers;
  const userID = req.params.userID;

  try {
    receivers.map((mp) => {
      if (mp !== userID) {
        BroadcastCoordinates(mp, coordinates);
      }
    });

    res.send({ status: true, message: "OK" });
  } catch (ex) {
    console.log(ex);
    res.send({ status: false, message: "Error decoding token" });
  }
});

router.get(
  "/sseNotifications/:token",
  [sse, jwtssechecker],
  async (req, res) => {
    const userID = req.params.userID;
    const entity_id = req.params.entity_id;
    const deviceToken = req.params.deviceToken;
    const contacts = await getPresenceScope(entity_id);
    const sessionstamp = `SESSION_STAMP_${makeid(15)}`;
    const redis_event = `events_${entity_id}`;

    listen(redis_event, res);

    const activeMetaData = {
      _id: entity_id,
      sessionStatus: true,
      sessiondate: {
        date: dateGetter(),
        time: timeGetter(),
      },
    };

    setUserSession(entity_id, deviceToken, true, async () => {
      // console.log("CONNECTED", userID);
      contacts.map((mp) => {
        UpdateContactswSessionStatus(mp, activeMetaData);
      });
    });

    req.on("close", () => {
      stop_listen(redis_event, res);
      const disconnectMetaData = {
        _id: entity_id,
        sessionStatus: false,
        sessiondate: {
          date: dateGetter(),
          time: timeGetter(),
        },
      };

      setUserSession(entity_id, deviceToken, false, async () => {
        // console.log("DISCONNECTED", userID);
        // clearASingleSession(userID, sessionstamp);

        const session_result = await UserSessions.find({
          entityID: entity_id,
          status: true,
        });

        if (session_result.length === 0) {
          contacts.map((mp) => {
            UpdateContactswSessionStatus(mp, disconnectMetaData);
          });
        }
      });
    });
  },
);

router.post("/logout", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const entity_id = req.params.entity_id;
  const deviceToken = req.params.deviceToken;

  await UserSessions.updateOne(
    { deviceToken, entityID: entity_id },
    { $set: { fcmToken: null } },
  )
    .then((result) => {
      res.send({ status: true, message: "OK" });
    })
    .catch((err) => {
      console.log(err);
      res.send({ status: false, message: "Error purging session" });
    });
});

router.get("/activecontacts", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const entity_id = req.params.entity_id;
  const contacts = await getPresenceScope(entity_id);

  await UserSessions.aggregate([
    {
      $match: {
        entityID: { $in: contacts },
      },
    },
    {
      $sort: {
        entityID: 1,
        lastSeen: -1,
      },
    },
    {
      $group: {
        _id: "$entityID",
        // `status`, NOT `sessionStatus`. The stored field is `status`
        // (schema/auth/sessions.js) - `sessionStatus` is only the name it
        // takes on the WIRE, assigned further down when the row is shaped for
        // the client. Both this and the $filter below used to read the wire
        // name against the stored document, where it does not exist: verified
        // against production, 0 of 165 session documents carry a
        // `sessionStatus` field and all 165 carry `status`.
        //
        // The effect was that hasTrue was always null, the $cond below never
        // took its first branch, and this stage silently degraded into "take
        // whichever session sorted first" - which the lastSeen sort made
        // look right for one device and wrong for several. An entity online
        // on an older session and freshly disconnected on a newer one read as
        // OFFLINE, because the newer row won on sort alone.
        //
        // That case is not hypothetical now: a page is online whenever ANY
        // admin is switched into it, so it is exactly the multi-session
        // entity this stage exists to resolve.
        hasTrue: { $max: "$status" },
        allSessions: { $push: "$$ROOT" },
      },
    },
    {
      $addFields: {
        filteredSessions: {
          $cond: [
            { $eq: ["$hasTrue", true] },
            {
              $filter: {
                input: "$allSessions",
                as: "s",
                cond: { $eq: ["$$s.status", true] },
              },
            },
            "$allSessions",
          ],
        },
      },
    },
    {
      $project: {
        // Returns the entire first session document (all schema fields)
        _id: 0,
        session: { $first: "$filteredSessions" },
      },
    },
    {
      $replaceWith: "$session", // Replaces the whole document with the session object
    },
  ])
    .then((result) => {
      const resultChecker = result.map((mp) => mp.entityID);
      const sessionFiller = contacts.map((mp) => {
        if (resultChecker.includes(mp)) {
          return {
            ...result.filter((flt) => flt.entityID == mp)[0],
            sessiondate: {
              date: result.filter((flt) => flt.entityID == mp)[0].lastSeen,
            },
            _id: result.filter((flt) => flt.entityID == mp)[0].entityID,
            sessionStatus: result.filter((flt) => flt.entityID == mp)[0].status,
          };
        } else {
          return {
            _id: mp,
            sessionStatus: false,
            sessiondate: null,
          };
        }
      });
      res.send({ status: true, result: sessionFiller });
    })
    .catch((err) => {
      console.log(err);
      res.send({ status: false, message: "Error getting active users" });
    });
});

router.post("/rejectcall", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const entity_id = req.params.entity_id;
  const token = req.body.token;

  try {
    const decodeToken = jwt.verify(token, JWT_SECRET);
    const conversationID = decodeToken.conversationID;
    const conversationType = decodeToken.conversationType;
    const callerID = decodeToken.caller.entityID;

    if (conversationType == "single") {
      CallRejectNotif(callerID, {
        conversationID: conversationID,
        rejectedBy: entity_id,
      });
    }

    res.send({ status: true, message: "OK" });
  } catch (ex) {
    console.log(ex);
    res.send({ status: false, message: "Cannot decode token" });
  }
});

router.post("/endcall", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const token = req.body.token;

  try {
    const decodeToken = jwt.verify(token, JWT_SECRET);
    const conversationID = decodeToken.conversationID;
    const conversationType = decodeToken.conversationType;
    const recepients = decodeToken.recepients;

    recepients.map((mp) => {
      CallRejectNotif(mp, {
        conversationID: conversationID,
        endedBy: userID,
      });
    });

    res.send({ status: true, message: "OK" });
  } catch (ex) {
    console.log(ex);
    res.send({ status: false, message: "Cannot decode token" });
  }
});

router.get("/sselogout", jwtchecker, (req, res) => {});

module.exports = router;
