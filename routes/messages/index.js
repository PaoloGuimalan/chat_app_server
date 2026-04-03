require("dotenv").config();
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const Axios = require("axios");

const UserAccount = require("../../schema/auth/useraccount");
const UserVerification = require("../../schema/auth/userverification");
const UploadedFiles = require("../../schema/posts/uploadedfiles");
const UserContacts = require("../../schema/users/contacts");
const UserMessage = require("../../schema/messages/message");
const { jwtchecker, createJWT } = require("../../reusables/hooks/jwthelper");
const {
  GetMessageReceivers,
  AddNewMemberToAllMessages,
  AddNewMemberToContacts,
  NotificationMessageForConversations,
  GetAllReceivers,
} = require("../../reusables/models/messages");
const {
  MessagesTrigger,
  BroadcastIsTypingStatus,
} = require("../../reusables/hooks/sse");
const {
  MESSAGES_TRIGGER_LOOPER,
  BROADCAST_IS_TYPING_STATUS_LOOPER,
} = require("../../reusables/vars/rabbitmqevents");
const producer = require("../../reusables/rabbitmq/producer");
const { publish } = require("../../reusables/redis/pubsub");
const pool = require("../../reusables/database/postgres");
const {
  formatConnectionData,
  formatToDesiredStructure,
} = require("../../reusables/hooks/transformers");

const MAILINGSERVICE_DOMAIN = process.env.MAILINGSERVICE;
const JWT_SECRET = process.env.JWT_SECRET;

const ssexpresssample = (req, res, next) => {
  console.log("SSE SAMPLE MIDDLEWARE");
  next();
};

router.get("/getMessages", [jwtchecker, ssexpresssample], (req, res) => {
  res.send({ status: true, message: "getMessages Testing endpoint" });
});

router.post("/deletemessage", jwtchecker, (req, res) => {
  const token = req.body.token;
  const userID = req.params.userID;

  try {
    const decodedToken = jwt.verify(token, JWT_SECRET);

    // console.log(decodedToken);

    UserMessage.updateOne(
      {
        conversationID: decodedToken.conversationID,
        messageID: decodedToken.messageID,
      },
      { isDeleted: true },
    )
      .then(async (result) => {
        const messageReceivers = await GetMessageReceivers(
          decodedToken.conversationID,
          decodedToken.messageID,
        );

        messageReceivers.map((user) => {
          MessagesTrigger(user, userID, false);
          // publish(`events_${user}`, MESSAGES_TRIGGER_LOOPER, {
          //   parameters: {
          //     receivers: messageReceivers,
          //     sender: userID,
          //     onseen: false,
          //   },
          // });
        });

        // await producer.publishMessage("INFO:CHATTERLOOP", MESSAGES_TRIGGER_LOOPER, {
        //     parameters: {
        //         receivers: messageReceivers,
        //         sender: userID,
        //         onseen: false
        //     }
        // });

        res.send({ status: true, message: "OK" });
      })
      .catch((err) => {
        res.send({ status: false, message: err.message });
      });
  } catch (ex) {
    console.log(ex);
    res.send({ status: false, message: "Error decoding token" });
  }
});

router.post("/addreaction", jwtchecker, (req, res) => {
  const token = req.body.token;
  const userID = req.params.userID;

  try {
    const decodedToken = jwt.verify(token, JWT_SECRET);

    // console.log(decodedToken);

    UserMessage.updateOne(
      {
        conversationID: decodedToken.conversationID,
        messageID: decodedToken.messageID,
      },
      { $push: { reactions: decodedToken.newreaction } },
    )
      .then(async (result) => {
        const messageReceivers = await GetMessageReceivers(
          decodedToken.conversationID,
          decodedToken.messageID,
        );

        messageReceivers.map((user) => {
          MessagesTrigger(user, userID, false);
          // publish(`events_${user}`, MESSAGES_TRIGGER_LOOPER, {
          //   parameters: {
          //     receivers: messageReceivers,
          //     sender: userID,
          //     onseen: false,
          //   },
          // });
        });

        // await producer.publishMessage("INFO:CHATTERLOOP", MESSAGES_TRIGGER_LOOPER, {
        //     parameters: {
        //         receivers: messageReceivers,
        //         sender: userID,
        //         onseen: false
        //     }
        // });

        res.send({ status: true, message: "OK" });
      })
      .catch((err) => {
        res.send({ status: false, message: err.message });
      });
  } catch (ex) {
    console.log(ex);
    res.send({ status: false, message: "Error decoding token" });
  }
});

async function getRealmWithUsers(realmId) {
  const query = `
    SELECT jsonb_build_object(
      'id', cr.id,
      'realm_id', cr.realm_id,
      'name', cr.name,
      'profile', cr.profile,
      'privacy', cr.is_private,
      'type', cr.type,
      'parent_id', cr.parent_id,
      'usersWithInfo', COALESCE(jsonb_agg(
        jsonb_build_object(
          '_id', ua.id,
          'userID', ua.username,
          'fullname', jsonb_build_object(
            'firstName', ua.first_name,
            'middleName', ua.middle_name,
            'lastName', ua.last_name
          ),
          'profile', ua.profile,
          'isActivated', ua.is_active,
          'isVerified', ua.is_verified,
          '__v', 0
        )
      ) FILTER (WHERE ua.id IS NOT NULL), '[]'::jsonb)
    ) AS realm_with_users
    FROM community_realm cr
    LEFT JOIN community_member cm ON cr.realm_id = cm.realm_id
    LEFT JOIN user_account ua ON cm.account_id = ua.id
    WHERE cr.realm_id = $1
    GROUP BY cr.id;
  `;

  const { rows } = await pool.query(query, [realmId]);
  return rows.length ? rows[0].realm_with_users : null;
}

router.get(
  "/conversationinfo/:conversationID/:type",
  jwtchecker,
  async (req, res) => {
    try {
      const userID = req.params.userID;
      const conversationID = req.params.conversationID;
      const type = req.params.type;

      if (type === "single") {
        const { rows } = await pool.query(
          "SELECT uc.*, ua.* FROM user_connection uc JOIN user_account ua ON ua.id = uc.involved_user_id WHERE uc.connection_id = $1;",
          [conversationID],
        );

        const formattedResult = formatConnectionData(rows);

        UploadedFiles.find({ foreignID: conversationID })
          .then((result) => {
            formattedResult.conversationfiles = result;
            var flattenedResults = formattedResult;
            const encodedResult = createJWT({
              data: flattenedResults,
            });
            res.send({ status: true, result: encodedResult });
          })
          .catch((err) => {
            console.log(err);
            res.send({
              status: false,
              message: "Cannot determine conversation details",
            });
          });
      } else {
        const result = await getRealmWithUsers(conversationID);
        const formattedResult = formatToDesiredStructure(result);

        UploadedFiles.find({ foreignID: conversationID })
          .then((result) => {
            formattedResult.conversationfiles = result;
            var flattenedResults = formattedResult;
            const encodedResult = createJWT({
              data: flattenedResults,
            });
            res.send({ status: true, result: encodedResult });
          })
          .catch((err) => {
            console.log(err);
            res.send({
              status: false,
              message: "Cannot determine conversation details",
            });
          });
      }
    } catch (err) {
      res.status(500).send({ status: false, message: "Invalid Group/Channel" });
    }
  },
);

router.post("/istypingbroadcast", jwtchecker, async (req, res) => {
  const token = req.body.token;
  const userID = req.params.userID;

  try {
    const decodedToken = jwt.verify(token, JWT_SECRET);
    const receiversfetch = await GetAllReceivers(decodedToken.conversationID);
    const receivers = receiversfetch.users.map((mp) => mp.userID); //Array decodedToken.receivers
    // const receivers = decodedToken.receivers;

    receivers.map((mp) => {
      if (mp !== userID) {
        BroadcastIsTypingStatus(mp, {
          userID: userID,
          conversationID: decodedToken.conversationID,
        });
      }
    });

    res.send({ status: true, message: "OK" });
  } catch (ex) {
    console.log(ex);
    res.send({ status: false, message: "Error decoding token" });
  }
});

router.post("/addnewmember", jwtchecker, async (req, res) => {
  const token = req.body.token;
  const userID = req.params.userID;
  const id = req.params.id;
  const username = req.params.username;

  try {
    const decodedToken = jwt.verify(token, JWT_SECRET);
    const conversationID = decodedToken.conversationID;
    const memberstoadd = decodedToken.memberstoadd;
    const receiversfetch = await GetAllReceivers(conversationID);
    const receivers = [
      ...decodedToken.receivers,
      ...receiversfetch.users.map((mp) => mp.userID),
    ];

    const { rows } = await pool.query(
      `SELECT id, username AS "userID" FROM user_account WHERE username = ANY($1);`,
      [memberstoadd.map((mp) => mp.userID)],
    );

    const { rows: get_group } = await pool.query(
      `SELECT parent_id FROM community_realm WHERE realm_id = $1 AND parent_id IS NOT NULL;`,
      [conversationID],
    );

    const conversationType = get_group.length > 0 ? "server" : "group";

    rows.map((mp) => {
      AddNewMemberToContacts(conversationID, mp.id, id)
        .then(() => {
          AddNewMemberToAllMessages(conversationID, mp.userID)
            .then(() => {
              NotificationMessageForConversations(
                conversationID,
                userID,
                receivers,
                `${username} added ${mp.userID}`,
                conversationType,
              );
            })
            .catch((err) => console.log);
        })
        .catch((err) => console.log);
    });

    // console.log(userID, decodedToken.conversationID, decodedToken.memberstoadd);

    res.send({ status: true, message: "OK" });
  } catch (ex) {
    console.log(ex);
    res.send({ status: false, message: "Error decoding token" });
  }
});

module.exports = router;
