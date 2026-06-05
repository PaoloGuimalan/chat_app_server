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
const { getAllParticipants } = require("../../reusables/redis/pubsub");
const { isRealmMember } = require("../../reusables/models/realms");

const JWT_SECRET = process.env.JWT_SECRET;

router.get("/publicservers", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const account_id = req.params.id;
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
        cr.cover_photo,
        cr.description,
        COUNT(cm.account_id) AS member_count,
        CASE 
            WHEN EXISTS (
                SELECT 1 FROM community_member cm2 
                WHERE cm2.realm_id = cr.realm_id AND cm2.account_id = $2
            ) THEN true 
            ELSE false 
        END AS is_joined
    FROM community_realm cr
    JOIN community_member cm ON cr.realm_id = cm.realm_id
    WHERE cm.account_id != $1
        AND cr.type = 'server' AND cr.is_private = false
    GROUP BY cr.id, cr.realm_id, cr.name, cr.profile, cr.created_by_id, cr.is_private, cr.type;
    `,
    [id, account_id],
  );

  res.send({ status: true, result: transformServersData(rows, true) });
});

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
        cr.cover_photo,
        cr.description,
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
    [id],
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

router.get(
  "/initserversetup/:parent_realm/:conversationID",
  jwtchecker,
  async (req, res) => {
    const userID = req.params.userID;
    const id = req.params.id;
    const conversationID = req.params.conversationID;
    const parent_realm = req.params.parent_realm;

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
    ])
      .then(async (result) => {
        // console.log(result)
        const receivers_list = result[0]?.receivers;

        let rows_final = [];

        if (receivers_list) {
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
          WHERE id = ANY($1)`,
            [receivers_list],
          );

          rows_final = rows;
        } else {
          const { rows } = await pool.query(
            `
            SELECT 
                ua.id AS "_id",
                ua.username AS "userID",
                json_build_object(
                  'firstName', ua.first_name,
                  'middleName', ua.middle_name,
                  'lastName', ua.last_name
                ) AS fullname,
                ua.profile
            FROM community_member cm
            JOIN user_account ua ON cm.account_id = ua.id
            JOIN community_realm cr ON cm.realm_id = cr.realm_id
            WHERE cr.realm_id = $1 AND cr.parent_id = $2;`,
            [conversationID, parent_realm],
          );

          rows_final = rows;
        }

        if (rows_final.filter((flt) => flt._id === id).length === 0) {
          res.status(401).send({
            status: false,
            message: "You do not have access to this channel",
          });
          return;
        }

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
            'type', 'server',
            'channelType', cr.type
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
        WHERE cr.realm_id = $1 AND cr.parent_id = $2;;`,
          [conversationID, parent_realm],
        );

        const details_result = details[0];

        if (!details_result) {
          res.status(400).send({
            status: false,
            message: "No Channel Matched",
          });

          return;
        }

        const encodedResult = jwt.sign(
          {
            conversationslist: [
              {
                conversationID: conversationID,
                ...result[0],
                users: rows_final,
                ...details_result,
              },
            ],
          },
          JWT_SECRET,
          {
            expiresIn: 60 * 60 * 24 * 7,
          },
        );

        res.send({ status: true, message: "OK", result: encodedResult });
      })
      .catch((err) => {
        console.log(err);
        res.status(400).send({
          status: false,
          message: "Error generating conversations list",
        });
      });
  },
);

router.get("/initserverchannels/:serverID", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const id = req.params.id;
  const serverID = req.params.serverID;

  const { rows: row } = await pool.query(
    `SELECT member_id FROM community_member WHERE account_id = $1 AND realm_id = $2;`,
    [id, serverID],
  );

  if (row.length === 0) {
    res
      .status(401)
      .send({ status: false, message: "You do not have access to this realm" });
    return;
  }

  const { rows } = await pool.query(
    `SELECT 
    json_build_object(
      '_id', cr.id,
      'serverID', cr.realm_id,
      'serverName', cr.name,
      'cover_photo', cr.cover_photo,
      'description', cr.description,
      'profile',
        CASE
          WHEN cr.profile = 'N/A' THEN ''
          ELSE cr.profile
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
        WHERE cm.realm_id = cr.realm_id
      ), '[]'::jsonb),
      'createdBy', pua.username,
      'privacy', cr.is_private,
      'is_admin', EXISTS (
        SELECT 1
        FROM community_member cm
        WHERE cm.account_id = $1
          AND cm.realm_id = cr.realm_id
          AND cm.role = 'admin'
      ),
      'channels', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            '_id', pcr.realm_id,
            'serverID', pcr.parent_id,
            'groupID', pcr.realm_id,
            'groupName', pcr.name,
            'profile',
              CASE
                WHEN pcr.profile = 'N/A' THEN ''
                ELSE pcr.profile
              END,
            'dateCreated', json_build_object(
              'date', '',
              'time', ''
            ),
            'createdBy', ppua.username,
            'type', 'server',
            'channelType', pcr.type,
            'privacy', pcr.is_private,
            'messages', jsonb_build_array(),
            'is_joined', EXISTS (
              SELECT 1
              FROM community_member cm
              WHERE cm.account_id = $1
                AND cm.realm_id = pcr.realm_id
            )
          )
        )
        FROM community_realm pcr
        LEFT JOIN user_account ppua ON pcr.created_by_id = ppua.id
        WHERE pcr.parent_id = cr.realm_id
      ), '[]'::jsonb),
      'usersWithInfo', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          '_id', cmu.id,
          'userID', cmu.username,
          'fullname', jsonb_build_object(
            'firstName', cmu.first_name,
            'middleName', cmu.middle_name,
            'lastName', cmu.last_name
          ),
          'profile',
            CASE
              WHEN cmu.profile = 'N/A' THEN 'none'
              ELSE cmu.profile
            END
        ))
        FROM community_member cm
        JOIN user_account cmu ON cm.account_id = cmu.id
        WHERE cm.realm_id = cr.realm_id
      ), '[]'::jsonb)
    )
   FROM community_realm cr
   LEFT JOIN user_account pua ON cr.created_by_id = pua.id
   WHERE cr.realm_id = $2;`,
    [id, serverID],
  );

  const deconstructedData = {
    ...rows[0].json_build_object,
  };

  UserMessage.aggregate([
    {
      $match: {
        conversationID: {
          $in: deconstructedData.channels.map((mp) => mp.groupID),
        },
        seeners: { $nin: [userID] },
      },
    },
    { $group: { _id: "$conversationID", unreadCount: { $sum: 1 } } },
  ])
    .then(async (result) => {
      const channelsWithReadsCount = deconstructedData.channels.map((mp) => ({
        ...mp,
        messages: result
          .map((mpp) => {
            if (mpp._id === mp.groupID) {
              if (mp.is_joined) {
                return {
                  unread: mpp.unreadCount,
                };
              }
            }
          })
          .filter((flt) => flt),
      }));

      const channelsWParticipants = await Promise.all(
        channelsWithReadsCount.map(async (mp) => ({
          ...mp,
          voice_participants: await getAllParticipants(mp.groupID),
        })),
      );

      const finalData = {
        ...deconstructedData,
        channels: channelsWParticipants,
      };

      const encodedResult = createJWT({
        data: [finalData],
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
  const id = req.params.id;
  const username = req.params.username;
  const token = req.body.token;

  try {
    const decodedToken = jwt.verify(token, JWT_SECRET);
    const serverID = decodedToken.serverID;
    const memberstoadd = decodedToken.memberstoadd;

    await isRealmMember(serverID, id);

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
      [memberstoadd.map((mp) => mp.userID), serverID],
    );

    const ServerChannelsList = await GetServerChannels(serverID, false);
    const mappedGroupID = ServerChannelsList.map((mp) => ({
      groupID: mp.groupID,
      type: mp.type,
    }));

    const removeAlreadyJoined = rows.filter((flt) => !flt.alreadyMember);

    AddNewMemberToChannels(
      id,
      username,
      {
        conversationID: serverID,
        memberstoadd: removeAlreadyJoined,
        receivers: decodedToken.receivers,
      },
      "server",
    );

    mappedGroupID.map((mp) => {
      AddNewMemberToChannels(
        id,
        username,
        {
          conversationID: mp.groupID,
          memberstoadd: removeAlreadyJoined,
          receivers: decodedToken.receivers,
        },
        mp.type,
      );
    });

    res.send({
      status: true,
      message: "Server updated",
      result: `Added ${removeAlreadyJoined.length} people`,
    });
  } catch (ex) {
    console.log(ex);
    res
      .status(400)
      .send({ status: false, message: ex.message || ex.toString() });
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
    },
  );

  res.send({ status: true, result: encodedResult });
});

router.put("/update-member-realm-role", jwtchecker, async (req, res) => {
  const id = req.params.id;
  const realm_id = req.body.realm_id;
  const member_id = req.body.member_id;
  const new_role = req.body.new_role;

  try {
    const { rows: row } = await pool.query(
      `SELECT member_id FROM community_member WHERE account_id = $1 AND realm_id = $2 AND role = $3;`,
      [id, realm_id, "admin"],
    );

    if (row.length === 0) {
      res.status(401).send({
        status: false,
        message: "You are not authorized to do this action",
      });
      return;
    }

    await pool.query(
      `UPDATE community_member SET role = $1 WHERE realm_id = $2 AND member_id = $3;`,
      [new_role, realm_id, member_id],
    );

    res.send({
      status: true,
      message: `Member ${member_id} updated role to ${new_role}`,
    });
  } catch (err) {
    console.log(err);
    res.send({
      status: false,
      message: "Error occured",
    });
  }
});

module.exports = router;
