require("dotenv").config();
const express = require("express");
const jwt = require("jsonwebtoken");
const { sseNotificationsWaiters } = require("../../reusables/hooks/sse");
const dateGetter = require("../../reusables/hooks/getDate");
const timeGetter = require("../../reusables/hooks/getTime");
const makeID = require("../../reusables/hooks/makeID");
const { jwtchecker, createJWT } = require("../../reusables/hooks/jwthelper");
const router = express.Router();

const UserServer = require("../../schema/users/servers");
const UserMessage = require("../../schema/messages/message");
const {
  GetServerChannels,
  GetServerDetails,
  GetServerMembers,
} = require("../../reusables/models/server");
const { AddNewMemberToChannels } = require("../../reusables/models/messages");
const pool = require("../../reusables/database/postgres");
const { transformServersData } = require("../../reusables/hooks/transformers");

const JWT_SECRET = process.env.JWT_SECRET;

router.get("/initserverlist", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const id = req.params.id;

  const { rows } = await pool.query(
    `
    SELECT 
        cr.id,
        cr.realm_id,
        cr.name,
        cr.profile,
        cr.created_by_id,
        cr.is_private,
        cr.type,
        (
        SELECT jsonb_agg(jsonb_build_object('userID', ua.username))
        FROM community_member cm2
        JOIN user_account ua ON cm2.account_id = ua.id
        WHERE cm2.realm_id = cr.realm_id
        ) AS members
    FROM community_realm cr
    JOIN community_member cm ON cr.realm_id = cm.realm_id
    WHERE cm.account_id = $1
        AND cr.type = 'server'
    GROUP BY cr.id, cr.realm_id, cr.name, cr.profile, cr.created_by_id, cr.is_private, cr.type;
    `,
    [id]
  );

  const encodedResult = createJWT(transformServersData(rows));
  res.send({ status: true, result: encodedResult });

  //   UserServer.find({ members: { $in: [{ userID: userID }] } })
  //     .then((result) => {
  //       const encodedResult = createJWT(result);
  //       res.send({ status: true, result: encodedResult });
  //     })
  //     .catch((err) => {
  //       console.log(err);
  //       res.send({ status: false, message: "Error fetching server list" });
  //     });
});

router.get("/initserversetup/:conversationID", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const conversationID = req.params.conversationID;

  await UserMessage.aggregate([
    {
      $match: {
        $and: [
          { receivers: { $in: [userID] } },
          { conversationID: conversationID },
        ],
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
      $sort: {
        sortID: -1,
      },
    },
    // {
    //   $lookup: {
    //     from: "useraccount",
    //     localField: "receivers",
    //     foreignField: "userID",
    //     as: "users",
    //   },
    // },
    // {
    //   $lookup: {
    //     from: "groups",
    //     localField: "conversationID",
    //     foreignField: "groupID",
    //     as: "groupdetails",
    //   },
    // },
    // {
    //   $unwind: {
    //     path: "$groupdetails",
    //     preserveNullAndEmptyArrays: true,
    //   },
    // },
    // {
    //   $lookup: {
    //     from: "servers",
    //     localField: "groupdetails.serverID",
    //     foreignField: "serverID",
    //     as: "serverdetails",
    //   },
    // },
    // {
    //   $unwind: {
    //     path: "$serverdetails",
    //     preserveNullAndEmptyArrays: true,
    //   },
    // },
    // {
    //   $project: {
    //     "users.birthdate": 0,
    //     "users.dateCreated": 0,
    //     "users.email": 0,
    //     "users.gender": 0,
    //     "users.isActivated": 0,
    //     "users.isVerified": 0,
    //     "users.password": 0,
    //   },
    // },
  ])
    .then(async(result) => {
      // console.log(result)
      const receivers_list = result[0].receivers;

      const { rows } = await pool.query(
        `
        SELECT
          id AS "_id",
          username AS "userID",
          json_build_object(
            'firstName', first_name,
            'middleName', middle_name,
            'lastName', last_name
          ) AS fullname,
          profile
        FROM user_account
        WHERE username = ANY($1)`,
        [receivers_list]
      );

      const { rows: details } = await pool.query(
        `SELECT
          json_build_object(
            '_id', cr.id,
            'serverID', cr.parent_id,
            'groupID', cr.realm_id,
            'groupName', cr.name,
            'profile',
            CASE
              WHEN cr.profile = 'N/A' THEN ''
              ELSE cr.profile
            END,
            'dateCreated', json_build_object(
              'date', '',
              'time', ''
            ),
            'createdBy', ua.username,
            'privacy', cr.is_private,
            'type', 'server'
          ) AS groupdetails,
          json_build_object(
            '_id', pcr.id,
            'serverID', pcr.realm_id,
            'serverName', pcr.name,
            'profile',
            CASE
              WHEN pcr.profile = 'N/A' THEN ''
              ELSE pcr.profile
            END,
            'dateCreated', json_build_object(
              'date', '',
              'time', ''
            ),
            'members', COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'userID', cm_username.username
              ))
              FROM community_member cm
              JOIN user_account cm_username ON cm.account_id = cm_username.id
              WHERE cm.realm_id = pcr.realm_id
            ), '[]'::jsonb),
            'createdBy', pua.username,
            'privacy', pcr.is_private
          ) AS serverdetails
        FROM community_realm cr
        LEFT JOIN user_account ua ON cr.created_by_id = ua.id
        LEFT JOIN community_realm pcr ON cr.parent_id = pcr.id
        LEFT JOIN user_account pua ON pcr.created_by_id = pua.id
        WHERE cr.realm_id = $1;`,
        [conversationID]
      );

      const details_result = details[0];

      const encodedResult = jwt.sign(
        {
          conversationslist: [{
            ...result[0],
            users: rows,
            ...details_result
          }],
        },
        JWT_SECRET,
        {
          expiresIn: 60 * 60 * 24 * 7,
        }
      );

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

router.get("/initserverchannels/:serverID", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const serverID = req.params.serverID;

  await UserServer.aggregate([
    {
      $match: {
        $and: [
          { serverID: serverID },
          { members: { $in: [{ userID: userID }] } },
        ],
      },
    },
    {
      $lookup: {
        from: "groups",
        localField: "serverID",
        foreignField: "serverID", //from groups
        pipeline: [
          {
            $lookup: {
              from: "messages",
              localField: "groupID",
              foreignField: "conversationID",
              pipeline: [
                {
                  $match: { seeners: { $nin: [userID] } },
                },
                {
                  $count: "unread",
                },
              ],
              as: "messages",
            },
          },
        ],
        as: "channels",
      },
    },
    {
      $lookup: {
        from: "useraccount",
        localField: "members.userID",
        foreignField: "userID",
        as: "usersWithInfo",
      },
    },
    {
      $project: {
        "usersWithInfo.birthdate": 0,
        "usersWithInfo.dateCreated": 0,
        "usersWithInfo.email": 0,
        "usersWithInfo.gender": 0,
        "usersWithInfo.isActivated": 0,
        "usersWithInfo.isVerified": 0,
        "usersWithInfo.password": 0,
      },
    },
  ])
    .then((result) => {
      // console.log(result[0].usersWithInfo)
      const encodedResult = createJWT({
        data: result,
      });
      res.send({ status: true, result: encodedResult });
    })
    .catch((err) => {
      console.log(err);
      res.send({ status: false, message: "Error fetching server" });
    });
});

router.post("/addnewmembertoserver", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const token = req.body.token;

  try {
    const decodedToken = jwt.verify(token, JWT_SECRET);
    const serverID = decodedToken.serverID;
    const memberstoadd = decodedToken.memberstoadd;
    const memberstoaddinserverdts = memberstoadd.map((mp) => ({
      userID: mp.userID,
    }));

    const GetServerDts = await GetServerDetails(serverID);
    const ServerChannelsList = await GetServerChannels(serverID, false);
    const mappedGroupID = ServerChannelsList.map((mp) => mp.groupID);

    const currentmembers = GetServerDts.members;

    const newsetofmembers = [...memberstoaddinserverdts, ...currentmembers];

    const uniquenewsetofmembers = newsetofmembers.filter((value, index) => {
      const _value = JSON.stringify(value);
      return (
        index ===
        newsetofmembers.findIndex((obj) => {
          return JSON.stringify(obj) === _value;
        })
      );
    });

    UserServer.updateOne(
      { serverID: serverID },
      { members: uniquenewsetofmembers }
    )
      .then(() => {
        mappedGroupID.map((mp) => {
          AddNewMemberToChannels(userID, {
            conversationID: mp,
            memberstoadd: memberstoadd,
            receivers: decodedToken.receivers,
          });
        });
        res.send({ status: true, message: "Server updated" });
      })
      .catch((err) => {
        console.log(err);
        res.send({ status: false, message: "Error updating server members" });
      });

    // console.log(decodedToken, mappedGroupID, uniqueArray);
  } catch (ex) {
    console.log(ex);
    res.send({ status: false, message: "Error decoding token" });
  }
});

router.get("/getservermembers/:serverID", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const serverID = req.params.serverID;

  const result = await GetServerMembers(serverID, true);

  const encodedResult = jwt.sign(
    {
      members: result,
    },
    JWT_SECRET,
    {
      expiresIn: 60 * 60 * 24 * 7,
    }
  );

  res.send({ status: true, result: encodedResult });
});

module.exports = router;
