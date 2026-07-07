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
const multiparty = require("multiparty");
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

const dateGetter = require("../../reusables/hooks/getDate");
const timeGetter = require("../../reusables/hooks/getTime");
const makeID = require("../../reusables/hooks/makeID");
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
} = require("../../reusables/models/messages");
const { GetServerMembers } = require("../../reusables/models/server");
const {
  createJWT,
  jwtchecker,
  jwtssechecker,
} = require("../../reusables/hooks/jwthelper");
const { requiresPermission, hasPermission } = require("../../reusables/hooks/permissionChecker");
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
} = require("../../reusables/models/users");
const {
  isRealmMember,
  GetRealmName,
} = require("../../reusables/models/realms");
const { bumpChatScore } = require("../../reusables/hooks/interactionscoring");

const MAILINGSERVICE_DOMAIN = process.env.MAILINGSERVICE;
const JWT_SECRET = process.env.JWT_SECRET;

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
  const newNotif = new UserNotifications(params);

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
});

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

      const finalNotification = result.map((mp) => ({
        ...mp,
        fromUser:
          rows.filter((flt) => flt.id === mp.fromUserID).length > 0
            ? rows.filter((flt) => flt.id === mp.fromUserID)[0]
            : null,
      }));

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

router.post(
  "/sendMessage",
  jwtchecker,
  requiresPermission("messages.send"),
  async (req, res) => {
  const userID = req.params.userID;
  const username = req.params.username;
  const id = req.params.id;
  const entity_id = req.params.entity_id;
  const token = req.body.token;

  try {
    const decodedToken = jwt.verify(token, JWT_SECRET);

    const pendingID = decodedToken.pendingID;

    const messageID = await checkExistingMessageID(makeID(30));
    const conversationID = decodedToken.conversationID;

    await isRealmMember(conversationID, entity_id);

    const sender = entity_id;
    const receiversfetch = await GetAllReceivers(conversationID);
    const receivers = receiversfetch.users.map((mp) => mp.entityID); //Array decodedToken.receivers

    const mentionedUsernames = extractMentionUsernames(decodedToken.content);

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

    const mentioner = {
      entityID: sender,
      username: `@${username}`,
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
    const replyingTo = decodedToken.replyingTo;
    const messageType = decodedToken.messageType;
    const conversationType = normalizeConversationType(
      decodedToken.conversationType,
    );

    const sanitizedContent = sanitizeForStorage(content);

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
          sanitizedContent,
          new Date(),
          messageType,
          false,
        );

        res.send({
          status: true,
          message: "Message Sent",
          pendingID: pendingID,
        });

        receivers.map((rcvs, i) => {
          const isMentioned = mentionedReceiverSet.has(rcvs);

          MessagesTrigger(
            rcvs,
            {
              conversationID,
              entityID: sender,
              mentioner: isMentioned ? mentioner : null,
            },
            false,
          );
        });
        bumpChatScore(conversationID, receivers, entity_id);
      })
      .catch((err) => {
        console.log(err);
        res.send({ status: false, message: "Error checking message" });
      });
  } catch (ex) {
    console.log(ex);
    res
      .status(400)
      .send({ status: false, message: ex.message || ex.toString() });
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
        replyingTo: { $last: "$replyingTo" },
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

      const usersWCns = await GetUsersWithConnectionIDs(directConversations);
      const flattenedReceiversArray = usersWCns.map((mp) => mp.user_id).flat();
      const removeDuplicateReceivers = [...new Set(flattenedReceiversArray)];

      const usersByConversationID = {};

      for (const item of usersWCns) {
        const { user_id, connection_ids } = item;

        for (const connID of connection_ids) {
          if (!usersByConversationID[connID]) {
            usersByConversationID[connID] = [];
          }
          usersByConversationID[connID].push(user_id);
        }
      }

      const { rows } = await pool.query(
        `SELECT 
              id AS _id,
              username AS "userID",
              json_build_object(
                'firstName', first_name,
                'middleName', middle_name,
                'lastName', last_name
              ) AS fullname,
              COALESCE(profile, 'none') AS profile
            FROM user_account
            WHERE id = ANY($1);`,
        [removeDuplicateReceivers],
      );

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
        const involvedUserIDs = usersByConversationID[mp.conversationID] || [];

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
          users: rows.filter((flt) => involvedUserIDs.includes(flt._id)), // mp.receivers.includes(flt._id)
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

    const { rows: realm_row } = await pool.query(
      `SELECT * FROM community_realm WHERE realm_id = $1`,
      [conversationID],
    );

    if (realm_row.length > 0) {
      // A page's own entity can never appear as a Member row of its own
      // realm (community_member only ever holds personal accounts) - so
      // once switched to act as this exact realm, the lookup below would
      // always miss and wrongly deny access to its own conversation.
      const isSelfRealmEntity = realm_row[0].entity_id === entity_id;

      if (!isSelfRealmEntity) {
        const { rows: is_member } = await pool.query(
          `SELECT member_id FROM community_member WHERE entity_id = $1 AND realm_id = $2;`,
          [entity_id, conversationID],
        );

        if (is_member.length <= 0) {
          res.status(401).send({
            status: false,
            message: "You do not have access to this conversation",
          });
          return;
        }
      }
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
      {
        $lookup: {
          from: "messages",
          localField: "replyingTo",
          foreignField: "messageID",
          as: "replyedmessage",
        },
      },
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
        $sort: {
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

        const { rows } = await pool.query(
          `SELECT 
              id AS _id,
              entity_id AS "entityID",
              username,
              id AS "userID",
              json_build_object(
                'firstName', first_name,
                'middleName', middle_name,
                'lastName', last_name
              ) AS fullname,
              COALESCE(profile, 'none') AS profile,
              is_active AS "isActivated",
              is_verified AS "isVerified"
            FROM user_account
            WHERE entity_id = ANY($1);`,
          [removeDuplicateReactors],
        );

        const mutatedMessagesArray = message.map((mp) => {
          const messageDocument = mp;
          const reactions = mp.reactions;

          if (reactions) {
            if (reactions.length > 0) {
              messageDocument.reactionsWithInfo = reactions.map((mp) => {
                const returnedRow = rows.filter(
                  (flt) => flt.entityID === mp.entityID,
                );

                if (returnedRow.length > 0) {
                  return returnedRow[0];
                }
              });
            } else {
              messageDocument.reactionsWithInfo = [];
            }
          }

          messageDocument.content = mp.isDeleted ? "" : mp.content;

          return messageDocument;
        });

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
  const content = `${username} ${message}`;
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
        ContactListTrigger(rcvs, `${username} created a group chat`);
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

    const { rows } = await client.query(
      `SELECT entity_id from user_account WHERE entity_id = ANY($1)`,
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
        params.push("admin"); // member role
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

    allReceivers.map((mp) => {
      const newChatHistory = new ChatHistory({
        conversationID: contactID,
        entityID: mp,
        cleared_at: null,
        isArchived: false,
        isRestricted: false,
      });

      newChatHistory.save();
    });

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
});

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

    const { rows } = await client.query(
      `SELECT id, username, entity_id from user_account WHERE entity_id = ANY($1)`,
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

    if (type !== "server" && type !== "voice" && type !== "page") {
      sendMessageInitForGC(
        contactID,
        entityID,
        rows.filter((mp) => mp.entity_id === entityID)[0].username,
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
});

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
        `${makeID(10)}_${files.profile[0].originalFilename}`,
        profileBuffer,
        `uploads/pages/${pageID}`,
      );
      const coverPhotoUpload = await Storage.upload(
        `${makeID(10)}_${files.cover_photo[0].originalFilename}`,
        coverPhotoBuffer,
        `uploads/pages/${pageID}`,
      );

      if (coverPhotoUpload && profileUpload) {
        createRealmReusable(
          entityID,
          null,
          pageID,
          pageName,
          profileUpload,
          coverPhotoUpload,
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
      mp.reference,
      mp.name,
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

    await saveFileRecordToDatabase(
      [messageID, mp.conversationID],
      publicUrl,
      "message",
      mp.type,
      "firebase",
      mp.name,
    );
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

router.post("/sendFiles", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const id = req.params.id;
  const entity_id = req.params.entity_id;
  const token = req.body.token;

  try {
    const decodeToken = jwt.verify(token, JWT_SECRET);

    const conversationID = decodeToken.conversationID;
    const receiversfetch = await GetAllReceivers(conversationID);
    const receivers = receiversfetch.users.map((mp) => mp.entityID); //Array decodedToken.receivers
    // const receivers = decodeToken.receivers;
    const files = decodeToken.files;
    const isReply = decodeToken.isReply;
    const replyingTo = decodeToken.replyingTo;
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

const getContactsForSession = async (entity_id) => {
  const sql = `
    SELECT DISTINCT ON (c.connection_id) c.*,
    a1.entity_id AS action_by_id,
    a2.entity_id AS involved_entity_id
    FROM user_connection c
    -- Fix: Join using the account's related entity_id field instead of the account primary key
    JOIN user_account a1 ON c.action_by_id = a1.entity_id
    JOIN user_account a2 ON c.involved_entity_id = a2.entity_id
    WHERE 
      (a1.entity_id = $1 OR a2.entity_id = $1)
      AND c.action_by_id <> c.involved_entity_id
      AND a1.is_active = TRUE
      AND a1.is_verified = TRUE
      AND a2.is_active = TRUE
      AND a2.is_verified = TRUE
      AND c.status = TRUE
    -- Note: DISTINCT ON requires an ORDER BY clause starting with the same expression
    ORDER BY c.connection_id, c.action_date DESC;
  `;

  const { rows } = await pool.query(sql, [entity_id]);
  const flattenedRows = rows.map((mp) => {
    if (mp.action_by_id == entity_id) {
      return mp.involved_entity_id;
    } else {
      return mp.action_by_id;
    }
  });

  return flattenedRows;
};

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
    const contacts = await getContactsForSession(entity_id);
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

router.get("/activecontacts", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const entity_id = req.params.entity_id;
  const contacts = await getContactsForSession(entity_id);

  // console.log(contacts)

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
        hasTrue: { $max: "$sessionStatus" },
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
                cond: { $eq: ["$$s.sessionStatus", true] },
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
    // publish(`events_${mp}`, CALL_REJECT_NOTIF_LOOPER, {
    //   parameters: {
    //     recepients: recepients,
    //     decodeToken: {
    //       conversationID: conversationID,
    //       endedBy: userID,
    //     },
    //   },
    // });
    // await producer.publishMessage(
    //   "INFO:CHATTERLOOP",
    //   CALL_REJECT_NOTIF_LOOPER,
    //   {
    //     parameters: {
    //       recepients: recepients,
    //       decodeToken: {
    //         conversationID: conversationID,
    //         endedBy: userID,
    //       },
    //     },
    //   }
    // );

    res.send({ status: true, message: "OK" });
  } catch (ex) {
    console.log(ex);
    res.send({ status: false, message: "Cannot decode token" });
  }
});

router.get("/sselogout", jwtchecker, (req, res) => {});

module.exports = router;
