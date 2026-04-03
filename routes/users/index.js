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
const { GetAllReceivers } = require("../../reusables/models/messages");
const { GetServerMembers } = require("../../reusables/models/server");
const {
  createJWT,
  jwtchecker,
  jwtssechecker,
} = require("../../reusables/hooks/jwthelper");
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
const { sanitizeForStorage } = require("../../reusables/hooks/transformers");

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

router.post("/requestContact", jwtchecker, async (req, res) => {
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

  if (userID) {
    await UserNotifications.updateMany(
      { toUserID: userID, isRead: false },
      { isRead: true },
    )
      .then(async (result) => {
        ReloadUserNotification(userID, "Notifications has been read");
        // publish(`events_${userID}`, "reload_user_notification", {
        //   parameters: {
        //     id: userID,
        //     details: "Notifications has been read",
        //   },
        // });
        // await producer.publishMessage(
        //   "INFO:CHATTERLOOP",
        //   "reload_user_notification",
        //   {
        //     parameters: {
        //       id: userID,
        //       details: "Notifications has been read",
        //     },
        //   }
        // );
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
  const page = req.headers["page"];
  const range = req.headers["range"];
  const UnreadNotificationsTotal = await CountAllUnreadNotifications(userID);

  await UserNotifications.aggregate([
    {
      $match: {
        toUserID: userID,
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
        "SELECT id, username, gender, profile, is_active, is_verified FROM user_account WHERE id = ANY($1);",
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

router.post("/sendMessage", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const token = req.body.token;

  try {
    const decodedToken = jwt.verify(token, JWT_SECRET);

    const pendingID = decodedToken.pendingID;

    const messageID = await checkExistingMessageID(makeID(30));
    const conversationID = decodedToken.conversationID;
    const sender = userID;
    const receiversfetch = await GetAllReceivers(conversationID);
    const receivers = receiversfetch.users.map((mp) => mp.userID); //Array decodedToken.receivers
    // const seeners = [userID]; //Array
    const seeners = []; //Array
    const content = decodedToken.content;
    const messageDate = {
      date: dateGetter(),
      time: timeGetter(),
    };
    const isReply = decodedToken.isReply;
    const replyingTo = decodedToken.replyingTo;
    const messageType = decodedToken.messageType;
    const conversationType = decodedToken.conversationType;

    const sanitizedContent = sanitizeForStorage(content);

    const payload = {
      messageID: messageID,
      conversationID: conversationID,
      pendingID: pendingID,
      sender: sender,
      receivers: receivers,
      seeners: seeners,
      content: sanitizedContent,
      messageDate: messageDate,
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
        res.send({
          status: true,
          message: "Message Sent",
          pendingID: pendingID,
        });
        receivers.map((rcvs, i) => {
          MessagesTrigger(rcvs, sender, false);
          // publish(`events_${rcvs}`, MESSAGES_TRIGGER_LOOPER, {
          //   parameters: {
          //     receivers: receivers,
          //     sender: sender,
          //     onseen: false,
          //   },
          // });
        });
        // await producer.publishMessage(
        //   "INFO:CHATTERLOOP",
        //   MESSAGES_TRIGGER_LOOPER,
        //   {
        //     parameters: {
        //       receivers: receivers,
        //       sender: sender,
        //       onseen: false,
        //     },
        //   }
        // );
      })
      .catch((err) => {
        console.log(err);
        res.send({ status: false, message: "Error checking message" });
      });
  } catch (ex) {
    console.log(ex);
    res.send({ status: false, message: "Failed to send message" });
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

  await UserMessage.aggregate([
    {
      $match: {
        receivers: { $in: [userID] },
      },
    },
    {
      $group: {
        _id: "$conversationID",
        sortID: { $last: "$_id" },
        conversationID: { $last: "$conversationID" },
        messageID: { $last: "$messageID" },
        conversationID: { $last: "$conversationID" },
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
        total: { $arrayElemAt: ["$metadata.total", 0] },
      },
    },
  ])
    .then(async (result_raw) => {
      const result = result_raw[0].data;
      const total = result_raw[0].total;
      const next = total - range * page > 0;
      const resultReceivers = result.map((mp) => mp.receivers);
      const resultGroups = result.map((mp) => mp.conversationID);

      const flattenedReceiversArray = resultReceivers.flat();
      const removeDuplicateReceivers = [...new Set(flattenedReceiversArray)];

      const flattenedGroupsArray = resultGroups.flat();

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
            WHERE username = ANY($1);`,
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
                'type', CASE WHEN cr.parent_id IS NOT NULL THEN 'server' ELSE cr.type END,
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
          users: rows.filter((flt) => mp.receivers.includes(flt.userID)),
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
    const conversationID = req.params.conversationID;
    const page = req.headers["page"];
    const range = req.headers["range"];
    const totalmessages =
      await GetAllMessageCountInAConversation(conversationID);

    await UserMessage.aggregate([
      //find({ userID: profileUserID }).sort({ _id: -1 }).limit(range)
      {
        $match: {
          conversationID: conversationID,
        },
      },
      {
        $lookup: {
          from: "messages",
          localField: "replyingTo",
          foreignField: "messageID",
          as: "replyedmessage",
        },
      },
      // {
      //   $lookup: {
      //     from: "useraccount",
      //     localField: "reactions.userID",
      //     foreignField: "userID",
      //     as: "reactionsWithInfo",
      //   },
      // },
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
              const reactionUsers = mp.reactions.map((mpp) => mpp.userID);

              return reactionUsers;
            }
          })
          .flat();

        const removeDuplicateReactors = [...new Set(flattenedUsersInReactions)];

        const { rows } = await pool.query(
          `SELECT 
              id AS _id,
              username AS "userID",
              json_build_object(
                'firstName', first_name,
                'middleName', middle_name,
                'lastName', last_name
              ) AS fullname,
              COALESCE(profile, 'none') AS profile,
              is_active AS "isActivated",
              is_verified AS "isVerified"
            FROM user_account
            WHERE username = ANY($1);`,
          [removeDuplicateReactors],
        );

        const mutatedMessagesArray = message.map((mp) => {
          const messageDocument = mp;
          const reactions = mp.reactions;

          if (reactions) {
            if (reactions.length > 0) {
              messageDocument.reactionsWithInfo = reactions.map((mp) => {
                const returnedRow = rows.filter(
                  (flt) => flt.userID === mp.userID,
                );

                if (returnedRow.length > 0) {
                  return returnedRow[0];
                }
              });
            } else {
              messageDocument.reactionsWithInfo = [];
            }
          }

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
  userID,
  username,
  recs,
  message,
  type,
) => {
  const messageID = await checkExistingMessageID(makeID(30));
  const conversationID = convID;
  const sender = userID;
  const receivers = recs; //Array
  const seeners = []; //Array
  const content = `${username} ${message}`;
  const messageDate = {
    date: dateGetter(),
    time: timeGetter(),
  };
  const isReply = false;
  const messageType = "notif";
  const conversationType = type;

  const payload = {
    messageID: messageID,
    conversationID: conversationID,
    sender: sender,
    receivers: receivers,
    seeners: seeners,
    content: content,
    messageDate: messageDate,
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
      receivers.map((rcvs, i) => {
        var sseWithUserID = sseNotificationsWaiters[rcvs];
        // if (sseWithUserID) {
        MessagesTrigger(rcvs, sender, false);
        ContactListTrigger(rcvs, `${userID} created a group chat`);
        // }
        // publish(`events_${rcvs}`, MESSAGES_TRIGGER_LOOPER, {
        //   parameters: {
        //     receivers: receivers,
        //     sender: sender,
        //     onseen: false,
        //   },
        // });
        // publish(`events_${rcvs}`, CONTACT_LIST_TRIGGER_LOOPER, {
        //   parameters: {
        //     receivers: receivers,
        //     details: `${userID} created a group chat`,
        //   },
        // });
      });
      //   await producer.publishMessage(
      //     "INFO:CHATTERLOOP",
      //     MESSAGES_TRIGGER_LOOPER,
      //     {
      //       parameters: {
      //         receivers: receivers,
      //         sender: sender,
      //         onseen: false,
      //       },
      //     }
      //   );
      //   await producer.publishMessage(
      //     "INFO:CHATTERLOOP",
      //     CONTACT_LIST_TRIGGER_LOOPER,
      //     {
      //       parameters: {
      //         receivers: receivers,
      //         details: `${userID} created a group chat`,
      //       },
      //     }
      //   );
    })
    .catch((err) => {
      console.log(err);
    });
};

router.post("/createContactGroupChat", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
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
    const allReceivers = [userID, ...otherUsers];
    const userReceivers = allReceivers.map((alr, i) => ({
      userID: alr,
    }));

    const { rows } = await client.query(
      `SELECT id from user_account WHERE id = ANY($1)`,
      [userReceivers.map((mp) => mp.userID)],
    );

    const insertValues = [];
    const params = [];
    let paramIndex = 1;

    rows.forEach(({ id: accountId }) => {
      insertValues.push(
        `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`,
      );
      // member_id - generate UUID here or use a package during insert if your DB auto-generates
      params.push(uuidv4()); // use a UUID generator (e.g. 'uuid' library)
      params.push(accountId); // account FK
      params.push(contactID); // pass your realm ID here
      params.push(id); // who added this member (account FK)
      params.push(new Date()); // date_joined or null as needed

      if (accountId === id) {
        params.push("admin"); // member role
      } else {
        params.push("member"); // member role
      }
    });

    await client.query(
      `INSERT INTO community_realm (
      id, realm_id, name, profile, type, created_by_id, parent_id, is_active, is_private, is_verified
      ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
      )`,
      [
        contactID,
        contactID,
        groupName,
        "N/A",
        "group",
        id,
        null,
        true,
        privacy,
        false,
      ],
    );

    await client.query(
      `
        INSERT INTO community_member (member_id, account_id, realm_id, added_by_id, date_joined, role)
        VALUES ${insertValues.join(", ")}
      `,
      params,
    );

    await client.query("COMMIT");

    // const newGroup = new UserGroups(groupParams);
    // newGroup
    //   .save()
    //   .then(async () => {
    sendMessageInitForGC(
      contactID,
      userID,
      username,
      allReceivers,
      "created the group chat",
      "group",
    );

    res.send({ status: true, message: `You created a Group Chat` });
    // })
    // .catch((err) => {
    //   res.send({
    //     status: false,
    //     message: "Creating a group encountered an error!",
    //   });
    //   console.log(err);
    // });

    // res.send({ status: true, message: `You created a Group Chat` })
    // })
    // .catch((err) => {
    //   res.send({
    //     status: false,
    //     message: "Creating a group contact encountered an error!",
    //   });
    //   console.log(err);
    // });
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
  userIDpass,
  userReceivers,
  privacyprop,
  type,
  email,
  slug,
) => {
  const userID = userIDpass;
  const profile = realmProfile || "N/A";

  const client = await pool.getPool();

  try {
    const contactID = realmID ?? (await checkGroupID(`${makeID(20)}`));
    const privacy = privacyprop;

    const allReceivers = userReceivers.map((mp) => mp.userID);

    const { rows } = await client.query(
      `SELECT id, username from user_account WHERE id = ANY($1)`,
      [allReceivers],
    );

    const insertValues = [];
    const params = [];
    let paramIndex = 1;

    rows.forEach(({ id: accountId }) => {
      insertValues.push(
        `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`,
      );
      // member_id - generate UUID here or use a package during insert if your DB auto-generates
      params.push(uuidv4()); // use a UUID generator (e.g. 'uuid' library)
      params.push(accountId); // account FK
      params.push(contactID); // pass your realm ID here
      params.push(id); // who added this member (account FK)
      params.push(new Date()); // date_joined or null as needed

      if (accountId === userID) {
        params.push("admin"); // member role
      } else {
        params.push("member"); // member role
      }
    });

    await client.query(
      `INSERT INTO community_realm (
      id, realm_id, name, profile, type, created_by_id, parent_id, is_active, is_private, is_verified, cover_photo, description, email, slug
      ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
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
      ],
    );

    await client.query(
      `
        INSERT INTO community_member (member_id, account_id, realm_id, added_by_id, date_joined, role)
        VALUES ${insertValues.join(", ")}
      `,
      params,
    );

    await client.query("COMMIT");

    if (type !== "server" && type !== "voice" && type !== "page") {
      sendMessageInitForGC(
        contactID,
        userID,
        rows.filter((mp) => mp.id === userID)[0].username,
        allReceivers,
        "created the group chat",
        parentRealmID ? "server" : "group",
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
  const token = req.body.token;

  try {
    const decodedToken = jwt.verify(token, JWT_SECRET);
    const serverID = decodedToken.serverID;
    const memberstoadd = decodedToken.otherUsers;
    const privacy = decodedToken.privacy;
    const type = decodedToken.type; // group (channel) or voice
    const groupName = decodedToken.groupName;

    const allReceivers = [userID, ...memberstoadd];
    const userReceivers = allReceivers.map((alr, i) => ({
      userID: alr,
    }));

    const serverMembers = await GetServerMembers(serverID, false);

    if (privacy) {
      createRealmReusable(
        id,
        serverID,
        null,
        groupName,
        null,
        null,
        null,
        userID,
        userReceivers,
        privacy,
        type, // "group"
        null,
        null,
      );
    } else {
      createRealmReusable(
        id,
        serverID,
        null,
        groupName,
        null,
        null,
        null,
        userID,
        serverMembers,
        privacy,
        type, // "group"
        null,
        null,
      );
    }

    res.send({ status: true, message: "OK" });
  } catch (ex) {
    console.log(ex);
    res.send({ status: false, message: "Error decoding token" });
  }
});

router.post("/createserver", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const id = req.params.id;
  const token = req.body.token;

  try {
    const decodeToken = jwt.verify(token, JWT_SECRET);
    const defaultchannellist = ["General", "Announcements", "Random"];

    const serverID = await checkGroupID(`${makeID(20)}`);
    const otherUsers = decodeToken.otherUsers;
    const serverName = decodeToken.groupName;
    const privacy = decodeToken.privacy;
    const allReceivers = [userID, ...otherUsers];
    const userReceivers = allReceivers.map((alr, i) => ({
      userID: alr,
    }));

    createRealmReusable(
      id,
      null,
      serverID,
      serverName,
      null,
      null,
      null,
      userID,
      userReceivers,
      privacy,
      "server",
      null,
      null,
    );

    defaultchannellist.map((mp) => {
      createRealmReusable(
        id,
        serverID,
        null,
        mp,
        null,
        null,
        null,
        userID,
        userReceivers,
        false,
        "group",
        null,
        null,
      );
    });
    res.send({ status: true, message: `You created a Group Chat` });
  } catch (ex) {
    res.send({ status: false, message: "Group token encountered an error!" });
    console.log(ex);
  }
});

router.post("/createpage", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const id = req.params.id;

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
      const allReceivers = [userID, ...otherUsers];
      const userReceivers = allReceivers.map((alr, i) => ({
        userID: alr,
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
          id,
          null,
          pageID,
          pageName,
          profileUpload,
          coverPhotoUpload,
          pageDescription,
          userID,
          userReceivers,
          false,
          "page",
          email,
          slug,
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
  const token = req.body.token;
  const range = req.headers["range"];

  // console.log("Seen", range);

  try {
    const decodeToken = jwt.verify(token, JWT_SECRET);

    const conversationID = decodeToken.conversationID;
    const receiversfetch = await GetAllReceivers(conversationID);
    const receivers = receiversfetch.users.map((mp) => mp.userID); //Array decodedToken.receivers
    // const receivers = decodeToken.receivers;

    // console.log(receivers)

    UserMessage.updateMany(
      {
        conversationID: conversationID,
        seeners: {
          $nin: [userID],
        },
      },
      {
        $push: {
          seeners: userID,
        },
      },
    )
      .then(async (result) => {
        if (result.modifiedCount > 0) {
          receivers.map((rcvs, i) => {
            MessagesTrigger(rcvs, userID, true);
          });
        }
        res.send({ status: true, message: "Seen OK" });
      })
      .catch((err) => {
        console.log(err);
        res.send({ status: false, message: "Cannot update seen status" });
      });
  } catch (ex) {
    console.log(ex);
    res.send({ status: false, message: "Error reading messages!" });
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
  userID,
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
      userID,
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
  userID,
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
  // const seeners = [userID]; //Array
  const seeners = []; //Array
  const messageDate = {
    date: dateGetter(),
    time: timeGetter(),
  };

  const payload = {
    messageID: messageID,
    conversationID: conversationID,
    pendingID: pendingID,
    sender: userID,
    receivers: receivers,
    seeners: seeners,
    content: content,
    messageDate: messageDate,
    isReply: isReply,
    replyingTo: replyingTo,
    reactions: [],
    isDeleted: false,
    messageType: messageType,
    conversationType: conversationType,
  };

  const newMessage = new UserMessage(payload);

  await newMessage
    .save()
    .then(async () => {
      onComplete(true);
    })
    .catch((err) => {
      onComplete(false);
      console.log(err);
    });
};

router.post("/sendFiles", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const token = req.body.token;

  try {
    const decodeToken = jwt.verify(token, JWT_SECRET);

    const conversationID = decodeToken.conversationID;
    const receiversfetch = await GetAllReceivers(conversationID);
    const receivers = receiversfetch.users.map((mp) => mp.userID); //Array decodedToken.receivers
    // const receivers = decodeToken.receivers;
    const files = decodeToken.files;
    const isReply = decodeToken.isReply;
    const replyingTo = decodeToken.replyingTo;
    const conversationType = decodeToken.conversationType;

    let settledFiles = 0;

    await Promise.allSettled(
      files.map((mp) => {
        uploadMessage(
          mp,
          userID,
          conversationID,
          receivers,
          isReply,
          replyingTo,
          conversationType,
          (status) => {
            settledFiles += 1;
            if (files.length === settledFiles) {
              receivers.map((rcvs, i) => {
                MessagesTrigger(rcvs, userID, false);
              });
            }
          },
        );
      }),
    );

    res.send({ status: true, message: "OK" });
  } catch (ex) {
    console.log(ex);
    res.send({ status: false, message: "Error decoding files!" });
  }
});

router.post("/call", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const token = req.body.token;

  try {
    const decodeToken = jwt.verify(token, JWT_SECRET);
    const recepients = decodeToken.recepients;

    recepients.map((rcp) => {
      ReachCallRecepients(rcp, decodeToken);
    });

    res.send({ status: true, message: "OK" });
  } catch (ex) {
    console.log(ex);
    res.send({ status: false, message: "Error declaring call!" });
  }
});

router.post("/notify-voice-join", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const clientID = req.body.clientID;
  const profile = req.body.profile;
  const recipients = req.body.recipients;
  const channelID = req.body.channelID;
  const instance = req.body.instance;

  try {
    recipients.map((rcp) => {
      ReachVoiceRecepients(rcp, {
        userID,
        profile,
        clientID,
        channelID,
        instance,
      });
    });

    addParticipant(channelID, {
      userID,
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

const getContactsForSession = async (userID) => {
  const sql = `
    SELECT DISTINCT ON (c.connection_id) c.*,
    a1.id AS action_by_id,
    a2.id AS involved_user_id
    FROM user_connection c
    JOIN user_account a1 ON c.action_by_id = a1.id
    JOIN user_account a2 ON c.involved_user_id = a2.id
    WHERE 
      (a1.id = $1 OR a2.id = $1)
      AND c.action_by_id <> c.involved_user_id
      AND a1.is_active = TRUE
      AND a1.is_verified = TRUE
      AND a2.is_active = TRUE
      AND a2.is_verified = TRUE
      AND c.status = TRUE;
  `;

  const { rows } = await pool.query(sql, [userID]);
  const flattenedRows = rows.map((mp) => {
    if (mp.action_by_id == userID) {
      return mp.involved_user_id;
    } else {
      return mp.action_by_id;
    }
  });

  return flattenedRows;
};

const checkSessionID = async (currentID) => {
  return await UserSessions.find({ sessionID: currentID })
    .then((result) => {
      if (result.length > 0) {
        checkSessionID(
          `SESSION_${makeID(20)}_${timeGetter()}_${dateGetter()}`
            .split(" ")
            .join("")
            .split(":")
            .join("_")
            .split("pm")
            .join("_")
            .split("/")
            .join("_"),
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

const setUserSession = async (userID, status, resolve) => {
  const newSessionID = await checkSessionID(
    `SESSION_${makeID(20)}_${timeGetter()}_${dateGetter()}`
      .split(" ")
      .join("")
      .split(":")
      .join("_")
      .split("pm")
      .join("_")
      .split("/")
      .join("_"),
  );
  const newSessionPayload = {
    sessionID: newSessionID,
    userID: userID,
    sessionStatus: status,
    sessiondate: {
      date: dateGetter(),
      time: timeGetter(),
    },
  };

  await UserSessions.find({ userID: userID })
    .then((result) => {
      if (result.length > 0) {
        UserSessions.updateMany({ userID: userID }, newSessionPayload)
          .then((_) => {
            resolve();
          })
          .catch((err) => {
            console.log(err);
          });
      } else {
        const newSession = new UserSessions(newSessionPayload);

        newSession
          .save()
          .then(() => {
            resolve();
          })
          .catch((err) => {
            console.log(err);
          });
      }
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
    const sseWithUserID = sseNotificationsWaiters[userID];
    const contacts = await getContactsForSession(userID);
    const sessionstamp = `SESSION_STAMP_${makeid(15)}`;
    const redis_event = `events_${userID}`;

    if (sseWithUserID) {
      sseNotificationsWaiters[userID] = {
        response: [
          ...sseWithUserID.response,
          {
            sessionstamp: sessionstamp,
            res: res,
          },
        ],
      };
    } else {
      sseNotificationsWaiters[userID] = {
        response: [
          {
            sessionstamp: sessionstamp,
            res: res,
          },
        ],
      };
    }

    listen(redis_event, res);

    const activeMetaData = {
      _id: userID,
      sessionStatus: true,
      sessiondate: {
        date: dateGetter(),
        time: timeGetter(),
      },
    };

    setUserSession(userID, true, async () => {
      // console.log("CONNECTED", userID);
      contacts.map((mp) => {
        UpdateContactswSessionStatus(mp, activeMetaData);
      });
    });

    req.on("close", () => {
      stop_listen(redis_event);
      const disconnectMetaData = {
        _id: userID,
        sessionStatus: false,
        sessiondate: {
          date: dateGetter(),
          time: timeGetter(),
        },
      };

      setUserSession(userID, false, async () => {
        // console.log("DISCONNECTED", userID);
        clearASingleSession(userID, sessionstamp);
        contacts.map((mp) => {
          UpdateContactswSessionStatus(mp, disconnectMetaData);
        });
      });
    });
  },
);

router.get("/activecontacts", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const contacts = await getContactsForSession(userID);

  // console.log(contacts)

  await UserSessions.aggregate([
    {
      $match: {
        userID: { $in: contacts },
      },
    },
    {
      $group: {
        _id: "$userID",
        sessionID: {
          $last: "$sessionID",
        },
        sessionStatus: {
          $last: "$sessionStatus",
        },
        sessiondate: {
          $last: "$sessiondate",
        },
      },
    },
  ])
    .then((result) => {
      const resultChecker = result.map((mp) => mp._id);
      const sessionFiller = contacts.map((mp) => {
        if (resultChecker.includes(mp)) {
          return result.filter((flt) => flt._id == mp)[0];
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
  const token = req.body.token;

  try {
    const decodeToken = jwt.verify(token, JWT_SECRET);
    const conversationID = decodeToken.conversationID;
    const conversationType = decodeToken.conversationType;
    const callerID = decodeToken.caller.userID;

    if (conversationType == "single") {
      CallRejectNotif(callerID, {
        conversationID: conversationID,
        rejectedBy: userID,
      });
      // publish(`events_${callerID}`, CALL_REJECT_NOTIF, {
      //   parameters: {
      //     rcp: callerID,
      //     decodeToken: {
      //       conversationID: conversationID,
      //       rejectedBy: userID,
      //     },
      //   },
      // });
      //   await producer.publishMessage("INFO:CHATTERLOOP", CALL_REJECT_NOTIF, {
      //     parameters: {
      //       rcp: callerID,
      //       decodeToken: {
      //         conversationID: conversationID,
      //         rejectedBy: userID,
      //       },
      //     },
      //   });
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
