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
const Conversations = require("../../schema/messages/conversation");
const { jwtchecker, createJWT } = require("../../reusables/hooks/jwthelper");
const {
  requiresPermission,
} = require("../../reusables/hooks/permissionChecker");
const {
  GetMessageReceivers,
  AddNewMemberToAllMessages,
  AddNewMemberToContacts,
  NotificationMessageForConversations,
  GetAllReceivers,
  SyncConversationLastMessage,
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
const { publish, getAllParticipants } = require("../../reusables/redis/pubsub");
const pool = require("../../reusables/database/postgres");
const {
  formatConnectionData,
  formatToDesiredStructure,
} = require("../../reusables/hooks/transformers");
const { isRealmMember } = require("../../reusables/models/realms");
const {
  GetUsersWithConnectionIDs,
  GetSenderDetails,
  GetEntityHandles,
} = require("../../reusables/models/users");
const conversation = require("../../schema/messages/conversation");
const makeid = require("../../reusables/hooks/makeID");

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
  const entity_id = req.params.entity_id;

  try {
    const decodedToken = jwt.verify(token, JWT_SECRET);

    await isRealmMember(decodedToken.conversationID, entity_id);

    const targetMessage = await UserMessage.findOne({
      conversationID: decodedToken.conversationID,
      messageID: decodedToken.messageID,
    });

    if (!targetMessage || String(targetMessage.sender) !== String(entity_id)) {
      return res
        .status(403)
        .send({ status: false, message: "You do not own this message." });
    }

    UserMessage.updateOne(
      {
        conversationID: decodedToken.conversationID,
        messageID: decodedToken.messageID,
      },
      { isDeleted: true },
    )
      .then(async (result) => {
        await SyncConversationLastMessage(decodedToken.conversationID);

        const messageReceivers = await GetAllReceivers(
          decodedToken.conversationID,
        );
        const parsedMessageReceivers = messageReceivers.users.map(
          (mp) => mp.entityID,
        );

        parsedMessageReceivers.map((entity) => {
          MessagesTrigger(
            entity,
            {
              conversationID: decodedToken.conversationID,
              entityID: entity_id,
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

router.post(
  "/addreaction",
  jwtchecker,
  requiresPermission("messages.react"),
  async (req, res) => {
    const token = req.body.token;
    const userID = req.params.userID;
    const id = req.params.id;
    const entity_id = req.params.entity_id;

    try {
      const decodedToken = jwt.verify(token, JWT_SECRET);

      await isRealmMember(decodedToken.conversationID, entity_id);

      UserMessage.updateOne(
        {
          conversationID: decodedToken.conversationID,
          messageID: decodedToken.messageID,
        },
        { $push: { reactions: decodedToken.newreaction } },
      )
        .then(async (result) => {
          const messageReceivers = await GetAllReceivers(
            decodedToken.conversationID,
          );

          messageReceivers.users.map((user) => {
            MessagesTrigger(
              user.entityID,
              {
                conversationID: decodedToken.conversationID,
                entityID: entity_id,
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
  },
);

async function getRealmWithUsers(realmId, entityID) {
  const query = `
    SELECT jsonb_build_object(
      'id', cr.id,
      'realm_id', cr.realm_id,
      'name', cr.name,
      'profile', cr.profile,
      'privacy', cr.is_private,
      'type', cr.type,
      'parent_id', cr.parent_id,
      'starts_at', cr.starts_at,
      'expires_at', cr.expires_at,
      'is_temporary', cr.is_temporary,
      'created_at', cr.created_at,
      'is_admin', (
        cr.entity_id = $2
        OR EXISTS (
          SELECT 1
          FROM community_member cm_admin
          WHERE cm_admin.entity_id = $2
            AND cm_admin.realm_id = cr.realm_id
            AND cm_admin.role IN ('admin', 'owner')
        )
      ),
      'is_member', (
        cr.entity_id = $2
        OR EXISTS (
          SELECT 1
          FROM community_member cm_member
          WHERE cm_member.entity_id = $2
            AND cm_member.realm_id = cr.realm_id
        )
      ),
      'usersWithInfo', COALESCE(jsonb_agg(
        jsonb_build_object(
          '_id', ua.id,
          'entityID', ua.entity_id,
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
    LEFT JOIN user_account ua ON cm.entity_id = ua.entity_id
    WHERE cr.realm_id = $1
    GROUP BY cr.id;
  `;

  const { rows } = await pool.query(query, [realmId, entityID]);
  return rows.length ? rows[0].realm_with_users : null;
}

router.get(
  "/conversationinfo/:conversationID/:type",
  jwtchecker,
  async (req, res) => {
    try {
      const userID = req.params.userID;
      const entity_id = req.params.entity_id;
      const conversationID = req.params.conversationID;
      const type = req.params.type;

      if (type === "single") {
        // Was previously missing - any authenticated account could load any
        // single/DM conversation's full details just by knowing its id, not
        // just their own. isRealmMember also covers single conversations
        // (checks entity_connection and, for connection-less conversations,
        // the Mongo Conversations doc's participant_ids).
        await isRealmMember(conversationID, entity_id);

        let chatHistory = null;
        chatHistory = await ChatHistory.findOne({
          conversationID: conversationID,
          entityID: entity_id,
        });

        const { rows } = await pool.query(
          "SELECT uc.*, ua.* FROM entity_connection uc JOIN user_account ua ON ua.entity_id = uc.involved_entity_id WHERE uc.connection_id = $1;",
          [conversationID],
        );

        const receivers = await GetAllReceivers(conversationID);

        if (!chatHistory) {
          // findOneAndUpdate+upsert instead of an unconditional .save() -
          // ChatHistory has no unique index on (conversationID, entityID),
          // so concurrent requests (e.g. two tabs opening the same
          // conversation) could each see chatHistory as null and both
          // insert, leaving a duplicate row that later fans this
          // conversation out into multiple rows in the conversations list.
          // Also fixed the missing await - .map() with an async callback
          // returns an array of promises that plain `await` doesn't wait on.
          await Promise.all(
            receivers.users.map(async (mp) => {
              const upsertedChatHistory = await ChatHistory.findOneAndUpdate(
                { conversationID: conversationID, entityID: mp.entityID },
                {
                  $setOnInsert: {
                    conversationID: conversationID,
                    entityID: mp.entityID,
                    cleared_at: null,
                    isArchived: false,
                    isRestricted: false,
                  },
                },
                { upsert: true, new: true },
              );

              if (entity_id === mp.entityID) {
                chatHistory = upsertedChatHistory;
              }
            }),
          );
        }

        let finalrows = rows;

        if (finalrows.length === 0) {
          const conversation = await Conversations.findOne({
            conversationID: conversationID,
          });

          const { rows: receiversFromChatHistory } = await pool.query(
            `SELECT 
              p.id AS "entity_id",
              -- entityID maps to the entity table ID column directly
              p.id AS "entityID",
              -- userID acts as the user_account username or community_realm slug
              COALESCE(u.username, r.slug) AS "userID",
              COALESCE(u.username, r.slug) AS "username",
              -- first_name pulls the real first name, or falls back to the community_realm name
              COALESCE(u.first_name, r.name) AS "first_name",
              -- middle_name and last_name are empty strings for realms
              COALESCE(u.middle_name, '') AS "middle_name",
              COALESCE(u.last_name, '') AS "last_name",
              COALESCE(u.profile, r.profile, 'none') AS "profile",
              -- Maps activation and verification states across tables
              COALESCE(u.is_active, r.is_active, TRUE) AS "isActivated",
              COALESCE(u.is_verified, FALSE) AS "isVerified"
            FROM entity_entity p
            LEFT JOIN user_account u ON u.entity_id = p.id AND p.type = 'user'
            LEFT JOIN community_realm r ON r.entity_id = p.id AND p.type = 'realm'
            WHERE p.id = ANY($1)`,
            [conversation.participant_ids],
          );

          finalrows = receiversFromChatHistory.map((mp) => ({
            ...mp,
            connection_id: conversationID,
            nickname: null,
            status: false,
            action_date: Date.now(),
            type: type,
            interaction_score: 0,
            last_interaction_at: Date.now(),
            action_by_id: mp.entity_id,
            involved_entity_id: mp.entity_id,
          }));
        }

        const formattedResult = formatConnectionData(finalrows);

        UploadedFiles.find({ foreignID: conversationID })
          .then((result) => {
            formattedResult.chatHistory = chatHistory;
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
        const { rows: realmRows } = await pool.query(
          `
            SELECT realm_id, type
            FROM community_realm
            WHERE realm_id = $1 OR slug = $1
            LIMIT 1
          `,
          [conversationID],
        );

        if (realmRows.length === 0) {
          return res
            .status(404)
            .send({ status: false, message: "Invalid Group/Channel" });
        }

        const resolvedConversationID = realmRows[0].realm_id;
        // realm.type is read from the DB, never trusted from the client's
        // :type route param, since that param is only used above to branch
        // single-vs-group and isn't validated against the actual realm.
        const isConferenceRealm = realmRows[0].type === "conference";

        // Was previously missing - any authenticated account could load any
        // group/channel's full member list and details just by knowing its
        // realm_id/slug, not just realms they belong to.
        let isMember = true;
        try {
          await isRealmMember(resolvedConversationID, entity_id);
        } catch (err) {
          if (!isConferenceRealm) {
            throw err;
          }
          // Conferences show a lobby before the caller has joined/accepted an
          // invite, so a non-member still needs enough info to render it -
          // just not the member roster or chat history (handled below).
          isMember = false;
        }

        if (!isMember) {
          const result = await getRealmWithUsers(
            resolvedConversationID,
            entity_id,
          );

          if (!result) {
            return res
              .status(404)
              .send({ status: false, message: "Invalid Group/Channel" });
          }

          const lobbyResult = { ...result, usersWithInfo: [] };
          const formattedResult = formatToDesiredStructure(lobbyResult);
          formattedResult.chatHistory = null;
          formattedResult.conversationfiles = [];

          const encodedResult = createJWT({ data: formattedResult });
          return res.send({ status: true, result: encodedResult });
        }

        let chatHistory = null;

        chatHistory = await ChatHistory.findOne({
          conversationID: resolvedConversationID,
          entityID: entity_id,
        });

        const result = await getRealmWithUsers(
          resolvedConversationID,
          entity_id,
        );
        const formattedResult = formatToDesiredStructure(result);

        const receivers = await GetAllReceivers(resolvedConversationID);

        if (!chatHistory) {
          // Same fix as the single-conversation branch above: atomic
          // upsert instead of an unawaited, unconditional .save() - avoids
          // duplicate chat_history rows under concurrent requests, which
          // fan a conversation out into multiple rows in the list later.
          await Promise.all(
            receivers.users.map(async (mp) => {
              const upsertedChatHistory = await ChatHistory.findOneAndUpdate(
                {
                  conversationID: resolvedConversationID,
                  entityID: mp.entityID,
                },
                {
                  $setOnInsert: {
                    conversationID: resolvedConversationID,
                    entityID: mp.entityID,
                    cleared_at: null,
                    isArchived: false,
                    isRestricted: false,
                  },
                },
                { upsert: true, new: true },
              );

              if (entity_id === mp.entityID) {
                chatHistory = upsertedChatHistory;
              }
            }),
          );
        }

        UploadedFiles.find({ foreignID: resolvedConversationID })
          .then((result) => {
            formattedResult.chatHistory = chatHistory;
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
      console.log(err);
      res.status(err.message ? 403 : 500).send({
        status: false,
        message: err.message || "Invalid Group/Channel",
      });
    }
  },
);

router.post("/istypingbroadcast", jwtchecker, async (req, res) => {
  const token = req.body.token;
  const userID = req.params.userID;
  const id = req.params.id;
  const entity_id = req.params.entity_id;

  try {
    const decodedToken = jwt.verify(token, JWT_SECRET);
    const receiversfetch = await GetAllReceivers(decodedToken.conversationID);
    const receivers = receiversfetch.users.map((mp) => mp.entityID); //Array decodedToken.receivers
    // const receivers = decodedToken.receivers;

    await isRealmMember(decodedToken.conversationID, entity_id);

    receivers.map((mp) => {
      if (mp !== entity_id) {
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
  const entityID = req.params.entity_id;
  const username = req.params.username;

  try {
    const actorDetails = await GetSenderDetails(entityID);
    const actorHandle = actorDetails?.handle || username;
    const decodedToken = jwt.verify(token, JWT_SECRET);
    const conversationID = decodedToken.conversationID;
    const memberstoadd = decodedToken.memberstoadd;
    const receiversfetch = await GetAllReceivers(conversationID);
    const receivers = [
      ...decodedToken.receivers,
      ...receiversfetch.users.map((mp) => mp.entityID),
    ];

    await isRealmMember(conversationID, entityID);

    const { rows } = await pool.query(
      `
        SELECT
          ua.id,
          ua.entity_id AS "entityID",
          ua.username AS "userID",
          EXISTS (
            SELECT 1
            FROM community_member cm
            WHERE cm.entity_id = ua.id
              AND cm.realm_id = $2
          ) AS "alreadyMember"
        FROM user_account ua
        WHERE ua.entity_id = ANY($1);
      `,
      [memberstoadd.map((mp) => mp.entityID), conversationID],
    );

    const { rows: get_group } = await pool.query(
      `SELECT parent_id, type FROM community_realm WHERE realm_id = $1`, //  AND parent_id IS NOT NULL;
      [conversationID],
    );

    const conversationType = get_group.length > 0 ? get_group[0].type : "group";
    const isPageOrVoice =
      get_group.length > 0
        ? get_group[0].type === "voice" || get_group[0].type === "page"
          ? true
          : false
        : false; // get_page_voice.length > 0

    const removeAlreadyJoined = rows.filter((flt) => !flt.alreadyMember);

    // One query for every target's handle - the alternative is interpolating
    // raw entity ids into text people read. Falls back to the id only when an
    // entity resolves to neither a user nor a realm.
    const targetHandles = await GetEntityHandles(
      removeAlreadyJoined.map((mp) => mp.entityID),
    );
    const handleFor = (id) =>
      targetHandles.get(String(id))?.handle || String(id);

    removeAlreadyJoined.map((mp) => {
      AddNewMemberToContacts(conversationID, mp.entityID, entityID)
        .then(() => {
          AddNewMemberToAllMessages(conversationID, mp.entityID)
            .then(() => {
              if (!isPageOrVoice) {
                NotificationMessageForConversations(
                  conversationID,
                  entityID,
                  receivers,
                  // actorHandle, not `username`: entityID is the ACTING
                  // entity, so adding members while switched to a page must
                  // read as the page, not its owner. handleFor resolves the
                  // target rather than printing its raw entity id.
                  `${actorHandle} added ${handleFor(mp.entityID)}`,
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
  const entityID = req.params.entity_id;
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
      { conversationID, entityID },
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

router.get("/archives", jwtchecker, async (req, res) => {
  try {
    const id = req.params.id;
    const entityID = req.params.entity_id;
    const page = req.headers["page"];
    const range = req.headers["range"];

    await UserMessage.aggregate([
      {
        $lookup: {
          from: "chat_history",
          let: { msg_conv_id: "$conversationID" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$conversationID", "$$msg_conv_id"] },
                    { $eq: ["$entityID", entityID] },
                    { $eq: ["$isArchived", true] }, // Only archived for this user
                  ],
                },
              },
            },
          ],
          as: "historySetting",
        },
      },
      {
        $match: {
          "historySetting.0": { $exists: true }, // Ensures historySetting is not empty (user has archived this conversation)
        },
      },
      {
        $unwind: {
          path: "$historySetting",
          preserveNullAndEmptyArrays: false, // Changed to false since we already filtered above
        },
      },
      {
        $match: {
          $expr: {
            $gt: [
              "$messageDate",
              {
                $ifNull: [
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
                  $in: [entityID, "$seeners"],
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
          total: { $ifNull: [{ $arrayElemAt: ["$metadata.total", 0] }, 0] },
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
        // participant info per conversation (users AND realms/pages), so a
        // user<->realm archived thread keeps its counterpart instead of it
        // getting dropped by a user_account-only lookup.
        const usersWCns = await GetUsersWithConnectionIDs(directConversations);

        const usersByConversationID = {};

        for (const item of usersWCns) {
          usersByConversationID[item.conversationID] = item.users;
        }

        const { rows: group_rows } = await pool.query(
          `SELECT 
                json_build_object(
                  '_id', cr.id,
                  'entityID', cr.entity_id,
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
                      'entityID', pr.entity_id,
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
                        JOIN user_account a ON m.entity_id = a.entity_id
                        WHERE m.realm_id = pr.realm_id
                      ),
                      'createdBy', parent_created_by.username,
                      'privacy', pr.is_private
                    )
                  ELSE NULL
                END AS serverdetails
              FROM community_realm cr
              LEFT JOIN community_realm pr ON cr.parent_id = pr.realm_id
              LEFT JOIN user_account created_by ON cr.created_by_id = created_by.entity_id
              LEFT JOIN user_account parent_created_by ON pr.created_by_id = parent_created_by.entity_id
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

        res.send({
          status: true,
          message: "OK",
          result: {
            archives: finalResultWParticipants,
            total,
            next,
          },
        });
      })
      .catch((err) => {
        console.log(err);
        res.status(400).send({
          status: false,
          message: "Error generating conversations list",
        });
      });
  } catch (ex) {
    console.log(ex);
    res
      .status(400)
      .send({ status: false, message: ex.message || ex.toString() });
  }
});

router.get("/conversations", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const entity_id = req.params.entity_id;
  const page = parseInt(req.headers["page"] || 1);
  const range = parseInt(req.headers["range"] || 20);
  const type = req.headers["type"] || "all";

  try {
    const typeSetup = {
      common: ["group", "single"],
      servers: ["channel"],
      groups: ["group"],
      direct: ["single"],
      conference: ["conference"],
    };

    const match = {
      participant_ids: { $in: [entity_id] },
      last_message: { $ne: null, $exists: true },
    };

    if (type !== "all") {
      const typeArray = typeSetup[type];

      if (typeArray) {
        match.conversationType = { $in: typeArray };
      }
    }

    const result_raw = await Conversations.aggregate([
      {
        $match: match,
      },
      {
        $lookup: {
          from: "chat_history",
          let: { msg_conv_id: "$conversationID" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$conversationID", "$$msg_conv_id"] },
                    { $eq: ["$entityID", entity_id] },
                  ],
                },
              },
            },
            // chat_history has no unique index on (conversationID, entityID)
            // and a handful of duplicate rows already exist from a prior race
            // condition in its creation path - without this, $unwind below
            // would fan a single conversation out into one row per duplicate,
            // showing the same conversation multiple times in the list.
            { $limit: 1 },
          ],
          as: "historySetting",
        },
      },
      {
        $unwind: {
          path: "$historySetting",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $match: {
          $expr: {
            $gt: [
              "$last_message.messageDate",
              {
                $ifNull: [
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
      {
        $match: {
          $expr: {
            $ne: [{ $ifNull: ["$historySetting.isArchived", false] }, true],
          },
        },
      },
      {
        $project: {
          sortID: "$last_message.messageDate",
          conversationID: 1,
          messageID: "$last_message.messageID",
          sender: "$last_message.sender",
          receivers: "$participant_ids",
          seeners: { $ifNull: ["$last_message.seeners", []] },
          content: {
            $cond: [
              { $eq: ["$last_message.isDeleted", true] },
              "",
              "$last_message.text",
            ],
          },
          messageDate: "$last_message.messageDate",
          isReply: { $literal: false },
          replyingTo: { $literal: "" },
          reactions: { $literal: [] },
          isDeleted: "$last_message.isDeleted",
          messageType: "$last_message.messageType",
          conversationType: 1,
          senderType: 1,
          authorRealm: 1,
        },
      },
      {
        $facet: {
          metadata: [{ $count: "total" }],
          data: [
            { $sort: { sortID: -1 } },
            { $skip: (page - 1) * range },
            { $limit: range },
          ],
        },
      },
      {
        $project: {
          data: 1,
          total: { $ifNull: [{ $arrayElemAt: ["$metadata.total", 0] }, 0] },
        },
      },
    ]);

    const result = result_raw[0]?.data || [];
    const total = result_raw[0]?.total || 0;
    const next = total - range * page > 0;

    const paginatedConversationIDs = result.map((mp) => mp.conversationID);

    const unreadByConversation =
      paginatedConversationIDs.length > 0
        ? await UserMessage.aggregate([
            {
              $match: {
                conversationID: { $in: paginatedConversationIDs },
              },
            },
            {
              $lookup: {
                from: "chat_history",
                let: { msg_conv_id: "$conversationID" },
                pipeline: [
                  {
                    $match: {
                      $expr: {
                        $and: [
                          { $eq: ["$conversationID", "$$msg_conv_id"] },
                          { $eq: ["$entityID", entity_id] },
                        ],
                      },
                    },
                  },
                  // Same duplicate chat_history guard as /conversations above
                  // - without it, a conversation with a duplicate row would
                  // fan every one of its messages out into 2+ copies here,
                  // doubling (or worse) its unread count.
                  { $limit: 1 },
                ],
                as: "historySetting",
              },
            },
            {
              $unwind: {
                path: "$historySetting",
                preserveNullAndEmptyArrays: true,
              },
            },
            {
              $match: {
                $expr: {
                  $and: [
                    {
                      $gt: [
                        "$messageDate",
                        {
                          $ifNull: [
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
                    {
                      $ne: [
                        { $ifNull: ["$historySetting.isArchived", false] },
                        true,
                      ],
                    },
                    {
                      $not: [{ $in: [entity_id, "$seeners"] }],
                    },
                  ],
                },
              },
            },
            {
              $group: {
                _id: "$conversationID",
                unread: { $sum: 1 },
              },
            },
          ])
        : [];

    const unreadMap = unreadByConversation.reduce((acc, current) => {
      acc[current._id] = current.unread || 0;
      return acc;
    }, {});

    const receiversEntity = [
      ...new Set(
        result
          .filter((flt) => flt.conversationType === "single")
          .flatMap((mp) => mp.receivers), // 1. Maps and flattens into a single array
      ), // 2. "Set" instantly enforces distinct unique entries
    ].filter((flt) => flt !== entity_id);

    const realmsEntity = [
      ...new Set(result.filter((flt) => flt.conversationType !== "single")),
    ].map((mp) => mp.conversationID);

    const { rows: realmRows } = await pool.query(
      `
      SELECT 
        realm_id as id,
        entity_id,
        slug AS username,
        name AS display_name,
        COALESCE(profile, 'none') AS profile
      FROM community_realm
      WHERE realm_id = ANY($1::TEXT[]);
    `,
      [realmsEntity],
    );

    const { rows: accountRows } = await pool.query(
      `
        SELECT
          p.id AS entity_id,
          p.type AS type,
          COALESCE(u.id, r.id) AS id,
          COALESCE(u.username, r.slug) AS username,
          FALSE AS privacy,
          -- Fallback mapping: uses concatenated user names or the realm name
          COALESCE(TRIM(u.first_name || ' ' || u.last_name), r.name) AS display_name,
          COALESCE(u.profile, r.profile, 'none') AS profile
        FROM entity_entity p
        LEFT JOIN user_account u ON u.entity_id = p.id AND p.type = 'user'
        LEFT JOIN community_realm r ON r.entity_id = p.id AND p.type = 'realm'
        WHERE p.id = ANY($1::TEXT[]);
      `,
      [receiversEntity],
    );

    const resultWithUnread = result.map((mp) => ({
      ...mp,
      unread: unreadMap[mp.conversationID] || 0,
    }));

    const accountMap = new Map(
      accountRows
        .filter((flt) => flt.entity_id !== entity_id)
        .map((row) => [row.entity_id, row]),
    );

    // 2. Convert realm database rows into an O(1) lookup Map keyed by realm_id (aliased as 'id')
    const realmMap = new Map(realmRows.map((row) => [row.id, row]));

    // 3. Hydrate the list of conversations
    const hydratedConversations = resultWithUnread.map((conversation) => {
      // --- CONDITION A: SINGLE CONVERSATION ---
      if (conversation.conversationType === "single") {
        // Map over participant_ids and append full user account details
        const hydratedParticipants = (
          conversation.receivers.filter((flt) => flt !== entity_id) || []
        ).map((entityId) => {
          return (
            accountMap.get(entityId) || {
              id: null,
              entity_id: entityId,
              username: "unknown",
              display_name: "Unknown User",
              profile: "none",
            }
          );
        });

        return {
          ...conversation,
          details: { ...hydratedParticipants[0] }, // Appends user account arrays here
        };
      }

      // --- CONDITION B: NOT SINGLE (REALM / GROUP) CONVERSATION ---
      if (conversation.conversationType !== "single") {
        // Look up realm info by matching conversationID against the realm_id string
        const matchedRealm = realmMap.get(conversation.conversationID) || {
          id: conversation.conversationID,
          entity_id: conversation.entity_id,
          username: "unknown",
          display_name: "Unknown Realm/Community",
          profile: "none",
        };

        return {
          ...conversation,
          details: matchedRealm, // Appends the specific single realm details object
        };
      }

      return conversation;
    });

    const finalResultWParticipants = await Promise.all(
      hydratedConversations.map(async (mp) => ({
        ...mp,
        voice_participants: await getAllParticipants(mp.conversationID),
      })),
    );

    res.send({
      status: true,
      message: "OK",
      result: {
        items: finalResultWParticipants,
        total,
        next,
      },
    });
  } catch (err) {
    console.log(err);
    res.send({
      status: false,
      message: "Error generating conversations list",
    });
  }
});

const checkExistingConversationID = async (conversationID) => {
  return await Conversations.find({ conversation_id: conversationID })
    .then((result) => {
      if (result.length > 0) {
        // Crucial: Must use 'return' here so the final clean ID passes back up the loop
        return checkExistingConversationID(makeid(20));
      } else {
        return conversationID;
      }
    })
    .catch((err) => {
      console.log(err);
      return false;
    });
};

router.post(
  "/crtc",
  jwtchecker,
  requiresPermission("conversations.create"),
  async (req, res) => {
    const userID = req.params.userID;
    const entity_id = req.params.entity_id;

    try {
      const otherEntityID = req.body.otherEntityID;

      // Safety check to ensure both keys are present before querying database collections
      if (!entity_id || !otherEntityID) {
        return res.status(400).json({
          status: false,
          message: "Missing entity identifiers for conversation creation.",
        });
      }

      // Do not let a user open a private chat room with themselves
      if (entity_id === otherEntityID) {
        return res.status(400).json({
          status: false,
          message: "Cannot initialize a direct conversation with yourself.",
        });
      }

      const initialParticipants = [entity_id, otherEntityID];

      // 1. Race Condition Check: Must contain exactly only those two participant IDs
      // $all checks for presence of both elements, $size enforces strict direct chat boundaries
      const existingConversation = await Conversations.findOne({
        participant_ids: {
          $all: initialParticipants,
          $size: 2,
        },
        conversationType: "single",
      });

      if (existingConversation) {
        // If a private room already exists, return its ID safely to prevent duplication
        return res.status(200).json({
          status: true,
          message: "Conversation already initialized",
          conversationID: existingConversation.conversationID,
          isNew: false,
        });
      }

      const newConversationID = await checkExistingConversationID(makeid(20));

      // 2. Fallback execution: Create a clean initialization layout
      const newConversation = await Conversations.create({
        conversationID: newConversationID,
        participant_ids: initialParticipants,
        conversationType: "single",
        last_message: null, // Kept null so it stays hidden from inbox listing aggregation maps
        created_at: new Date(),
        updated_at: new Date(),
      });

      return res.status(201).json({
        status: true,
        message: "Conversation successfully initialized",
        conversationID: newConversation.conversationID,
        isNew: true,
      });
    } catch (err) {
      console.log(err);
      res.send({
        status: false,
        message: "Error initializing conversation",
      });
    }
  },
);

router.get("/conversation/:conversationID", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const entity_id = req.params.entity_id;
  const conversationID = req.params.conversationID;

  try {
    // Was previously missing entirely - any authenticated account could
    // load full details (participants, display names, profiles) of any
    // conversationID, not just their own. isRealmMember throws if entity_id
    // isn't a participant/member, same guard already used by every other
    // route in this file that touches a conversation by id.
    await isRealmMember(conversationID, entity_id);

    const baseConversation = await Conversations.findOne({
      conversationID: conversationID,
    }).lean();

    const result = baseConversation ? [baseConversation] : [];

    const receiversEntity = await GetAllReceivers(conversationID);
    const users = receiversEntity.users;
    let recipients = receiversEntity.users
      .map((mp) => mp.entityID)
      .filter((flt) => flt !== entity_id);

    if (recipients.length === 0) {
      const conversation = await Conversations.findOne({
        conversationID: conversationID,
      });

      const { rows: receiversFromChatHistory } = await pool.query(
        'SELECT entity_id AS "entityID" FROM user_account WHERE entity_id = ANY($1)',
        [conversation.participant_ids.filter((flt) => flt !== entity_id)],
      );

      recipients = receiversFromChatHistory.map((mp) => mp.entityID);
    }

    const realmsEntity = [conversationID];

    const { rows: realmRows } = await pool.query(
      `
      SELECT 
        realm_id as id,
        entity_id,
        slug AS username,
        name AS display_name,
        is_private AS privacy,
        COALESCE(profile, 'none') AS profile
      FROM community_realm
      WHERE realm_id = ANY($1::TEXT[]);
    `,
      [realmsEntity],
    );

    const { rows: accountRows } = await pool.query(
      `
        SELECT
          p.id AS entity_id,
          p.type AS type,
          COALESCE(u.id, r.id) AS id,
          COALESCE(u.username, r.slug) AS username,
          FALSE AS privacy,
          -- Fallback mapping: uses concatenated user names or the realm name
          COALESCE(TRIM(u.first_name || ' ' || u.last_name), r.name) AS display_name,
          COALESCE(u.profile, r.profile, 'none') AS profile
        FROM entity_entity p
        LEFT JOIN user_account u ON u.entity_id = p.id AND p.type = 'user'
        LEFT JOIN community_realm r ON r.entity_id = p.id AND p.type = 'realm'
        WHERE p.id = ANY($1::TEXT[]);
      `,
      [recipients],
    );

    const accountMap = new Map(
      accountRows
        .filter((flt) => flt.entity_id !== entity_id)
        .map((row) => [row.entity_id, row]),
    );

    // 2. Convert realm database rows into an O(1) lookup Map keyed by realm_id (aliased as 'id')
    const realmMap = new Map(realmRows.map((row) => [row.id, row]));

    // considered as single new conversation
    if (users.length > 0 && realmRows.length === 0) {
      const details = (recipients || []).map((entityId) => {
        return (
          accountMap.get(entityId) || {
            id: null,
            entity_id: entityId,
            username: "unknown",
            display_name: "Unknown User",
            profile: "none",
          }
        );
      });

      const final = {
        conversationID: conversationID,
        conversationType: "single",
        participant_ids: recipients,
        last_message: null,
        createdAt: null,
        updatedAt: null,
        details: details[0],
        voice_participants: await getAllParticipants(conversationID),
      };

      res.send({
        status: true,
        message: "OK",
        result: final,
      });

      return;
    }

    // 3. Hydrate the list of conversations
    const hydratedConversations = result.map((conversation) => {
      // --- CONDITION A: SINGLE CONVERSATION ---
      if (conversation.conversationType === "single") {
        // Map over participant_ids and append full user account details
        const hydratedParticipants = (
          conversation.participant_ids.filter((flt) => flt !== entity_id) || []
        ).map((entityId) => {
          return (
            accountMap.get(entityId) || {
              id: null,
              entity_id: entityId,
              username: "unknown",
              display_name: "Unknown User",
              profile: "none",
            }
          );
        });

        return {
          ...conversation,
          details: { ...hydratedParticipants[0] }, // Appends user account arrays here
        };
      }

      // --- CONDITION B: NOT SINGLE (REALM / GROUP) CONVERSATION ---
      if (conversation.conversationType !== "single") {
        // Look up realm info by matching conversationID against the realm_id string
        const matchedRealm = realmMap.get(conversation.conversationID) || {
          id: conversation.conversationID,
          entity_id: conversation.entity_id,
          username: "unknown",
          display_name: "Unknown Realm/Community",
          profile: "none",
        };

        return {
          ...conversation,
          details: matchedRealm, // Appends the specific single realm details object
        };
      }

      return conversation;
    });

    const finalResultWParticipants = await Promise.all(
      hydratedConversations.map(async (mp) => ({
        ...mp,
        voice_participants: await getAllParticipants(mp.conversationID),
      })),
    );

    res.send({
      status: true,
      message: "OK",
      result:
        finalResultWParticipants.length > 0
          ? finalResultWParticipants[0]
          : null,
    });
  } catch (err) {
    console.log(err);
    res.status(400).send({
      status: false,
      message: err.message || "Error generating conversations list",
    });
  }
});

module.exports = router;
