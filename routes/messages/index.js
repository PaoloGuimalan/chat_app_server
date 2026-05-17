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
const ChatHistory = require("../../schema/messages/chathistory");
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
const { isRealmMember } = require("../../reusables/models/realms");

const MAILINGSERVICE_DOMAIN = process.env.MAILINGSERVICE;
const JWT_SECRET = process.env.JWT_SECRET;

const ssexpresssample = (req, res, next) => {
  console.log("SSE SAMPLE MIDDLEWARE");
  next();
};

router.get("/getMessages", [jwtchecker, ssexpresssample], (req, res) => {
  res.send({ status: true, message: "getMessages Testing endpoint" });
});

router.post("/deletemessage", jwtchecker, async (req, res) => {
  const token = req.body.token;
  const userID = req.params.userID;
  const id = req.params.id;

  try {
    const decodedToken = jwt.verify(token, JWT_SECRET);

    await isRealmMember(decodedToken.conversationID, id);

    UserMessage.updateOne(
      {
        conversationID: decodedToken.conversationID,
        messageID: decodedToken.messageID,
      },
      { isDeleted: true },
    )
      .then(async (result) => {
        const messageReceivers = await GetAllReceivers(
          decodedToken.conversationID,
        );
        const parsedMessageReceivers = messageReceivers.users.map(
          (mp) => mp.userID,
        );

        parsedMessageReceivers.map((user) => {
          MessagesTrigger(
            user,
            {
              conversationID: decodedToken.conversationID,
              userID: userID,
              deletedMessageID: decodedToken.messageID,
            },
            false,
          );
        });

        res.send({ status: true, message: "OK" });
      })
      .catch((err) => {
        res.send({ status: false, message: err.message });
      });
  } catch (ex) {
    console.log(ex);
    res
      .status(400)
      .send({ status: false, message: ex.message || ex.toString() });
  }
});

router.post("/addreaction", jwtchecker, async (req, res) => {
  const token = req.body.token;
  const userID = req.params.userID;
  const id = req.params.id;

  try {
    const decodedToken = jwt.verify(token, JWT_SECRET);

    await isRealmMember(decodedToken.conversationID, id);

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
          MessagesTrigger(
            user,
            { conversationID: decodedToken.conversationID, userID },
            false,
          );
        });

        res.send({ status: true, message: "OK" });
      })
      .catch((err) => {
        res.send({ status: false, message: err.message });
      });
  } catch (ex) {
    console.log(ex);
    res
      .status(400)
      .send({ status: false, message: ex.message || ex.toString() });
  }
});

async function getRealmWithUsers(realmId, userID) {
  const query = `
    SELECT jsonb_build_object(
      'id', cr.id,
      'realm_id', cr.realm_id,
      'name', cr.name,
      'profile', cr.profile,
      'privacy', cr.is_private,
      'type', cr.type,
      'parent_id', cr.parent_id,
      'is_admin', EXISTS (
        SELECT 1
        FROM community_member cm_admin
        WHERE cm_admin.account_id = $2
          AND cm_admin.realm_id = cr.realm_id
          AND cm_admin.role = 'admin'
      ),
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

  const { rows } = await pool.query(query, [realmId, userID]);
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
        const result = await getRealmWithUsers(conversationID, userID);
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
  const id = req.params.id;

  try {
    const decodedToken = jwt.verify(token, JWT_SECRET);
    const receiversfetch = await GetAllReceivers(decodedToken.conversationID);
    const receivers = receiversfetch.users.map((mp) => mp.userID); //Array decodedToken.receivers
    // const receivers = decodedToken.receivers;

    await isRealmMember(decodedToken.conversationID, id);

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
    res
      .status(400)
      .send({ status: false, message: ex.message || ex.toString() });
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

    await isRealmMember(conversationID, id);

    const { rows } = await pool.query(
      `
        SELECT
          ua.id,
          ua.username AS "userID",
          EXISTS (
            SELECT 1
            FROM community_member cm
            WHERE cm.account_id = ua.id
              AND cm.realm_id = $2
          ) AS "alreadyMember"
        FROM user_account ua
        WHERE ua.username = ANY($1);
      `,
      [memberstoadd.map((mp) => mp.userID), conversationID],
    );

    const { rows: get_group } = await pool.query(
      `SELECT parent_id FROM community_realm WHERE realm_id = $1 AND parent_id IS NOT NULL;`,
      [conversationID],
    );

    const { rows: get_page_voice } = await pool.query(
      `SELECT realm_id 
        FROM community_realm 
        WHERE realm_id = $1 
      AND type IN ('page', 'voice');`,
      [conversationID],
    );

    const conversationType = get_group.length > 0 ? "server" : "group";
    const isPageOrVoice = get_page_voice.length > 0;

    const removeAlreadyJoined = rows.filter((flt) => !flt.alreadyMember);

    removeAlreadyJoined.map((mp) => {
      AddNewMemberToContacts(conversationID, mp.id, id)
        .then(() => {
          AddNewMemberToAllMessages(conversationID, mp.userID)
            .then(() => {
              if (!isPageOrVoice) {
                NotificationMessageForConversations(
                  conversationID,
                  userID,
                  receivers,
                  `${username} added ${mp.userID}`,
                  conversationType,
                );
              }
            })
            .catch((err) => console.log);
        })
        .catch((err) => console.log);
    });

    res.send({
      status: true,
      message: "OK",
      result: `Added ${removeAlreadyJoined.length} people`,
    });
  } catch (ex) {
    console.log(ex);
    res
      .status(400)
      .send({ status: false, message: ex.message || ex.toString() });
  }
});

router.post("/history", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const id = req.params.id;
  const username = req.params.username;

  try {
    const { conversationID, action } = req.body;

    if (!conversationID || !userID || !action) {
      return res.status(400).json({
        success: false,
        message:
          "Missing parameters: conversationID, userID, and action are required.",
      });
    }

    let updatePayload = {};

    switch (action) {
      case "clear":
        updatePayload.cleared_at = new Date();
        break;
      case "archive":
        updatePayload.isArchived = true;
        break;
      case "unarchive":
        updatePayload.isArchived = false;
        break;
      case "restrict":
        updatePayload.isRestricted = true;
        break;
      case "unrestrict":
        updatePayload.isRestricted = false;
        break;
      default:
        return res.status(400).json({
          success: false,
          message: `Invalid system action: '${action}'. Valid actions are clear, archive, unarchive, restrict, unrestrict.`,
        });
    }

    const updatedState = await ChatHistory.findOneAndUpdate(
      { conversationID, userID },
      { $set: updatePayload },
      { upsert: true, new: true },
    );

    return res.status(200).json({
      success: true,
      message: `Action '${action}' processed successfully.`,
      data: updatedState,
    });
  } catch (ex) {
    console.log(ex);
    res
      .status(400)
      .send({ status: false, message: ex.message || ex.toString() });
  }
});

module.exports = router;
