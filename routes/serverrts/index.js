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
const {
  AddNewMemberToChannels,
  GetAllReceivers,
} = require("../../reusables/models/messages");
const pool = require("../../reusables/database/postgres");
const { hasPermission } = require("../../reusables/hooks/permissionChecker");
const { transformServersData } = require("../../reusables/hooks/transformers");
const { getAllParticipants, publish } = require("../../reusables/redis/pubsub");
const {
  isRealmMember,
  isRealmPublic,
} = require("../../reusables/models/realms");

const JWT_SECRET = process.env.JWT_SECRET;

router.get("/publicservers", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const entity_id = req.params.entity_id;

  try {
    // Keyed on entity_id, not account_id.
    //
    // community_member.account_id is a LEGACY column: Django's Member model
    // has its `account` FK commented out in favour of `entity`, and every
    // INSERT INTO community_member in this service writes entity_id and omits
    // account_id entirely (routes/users/index.js, reusables/models/messages.js).
    // So every membership row created since the entity migration has
    // account_id NULL, and this query was reading a column nothing fills.
    //
    // That made all three uses wrong, and silently:
    //   COUNT(cm.account_id)  counts only NON-NULL values, so member_count
    //                         was 0 for any server whose members all joined
    //                         after the migration.
    //   cm.account_id != $1   NULL != x is NULL, never true - so those rows
    //                         were filtered out and the directory came back
    //                         short, or empty.
    //   cm2.account_id = $2   likewise never matched, so is_joined was false
    //                         for servers you are in.
    //
    // A page could never satisfy any of them at all: an acting entity has no
    // account_id by definition, which is the same acting-as-page failure as
    // /initserverlist's, just silent instead of fatal.
    //
    // Both placeholders were being passed req.params.id - the same value
    // twice - so they collapse to one.
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
        COUNT(cm.entity_id) AS member_count,
        CASE
            WHEN EXISTS (
                SELECT 1 FROM community_member cm2
                WHERE cm2.realm_id = cr.realm_id AND cm2.entity_id = $1
            ) THEN true
            ELSE false
        END AS is_joined
    FROM community_realm cr
    JOIN community_member cm ON cr.realm_id = cm.realm_id
    WHERE cm.entity_id != $1
        AND cr.type = 'server' AND cr.is_private = false
    GROUP BY cr.id, cr.realm_id, cr.name, cr.profile, cr.created_by_id, cr.is_private, cr.type;
    `,
      [entity_id],
    );

    res.send({ status: true, result: transformServersData(rows, true) });
  } catch (ex) {
    // No handler here either - see /initserverlist below for why that turns a
    // query error into a hung request rather than a response.
    console.log(ex);
    res
      .status(400)
      .send({ status: false, message: ex.message || ex.toString() });
  }
});

router.get("/initserverlist", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const id = req.params.id;
  const entity_id = req.params.entity_id;

  try {
    const { rows } = await pool.query(
      `
    SELECT 
        cr.id,
        cr.entity_id,
        cr.realm_id,
        cr.name,
        cr.profile,
        cr.created_by_id,
        cr.is_private,
        cr.type,
        cr.cover_photo,
        cr.description,
        -- Entity-generic, and never NULL. Two separate bugs lived here:
        --
        -- The INNER JOIN to user_account dropped every member that is a PAGE
        -- (community_member.entity_id can be a person OR a realm - see
        -- GetServerMembers, which had this same fix). And jsonb_agg over zero
        -- surviving rows returns NULL, not '[]', so a server whose members are
        -- all pages came back with members = null and transformServersData
        -- threw on .map - which is what an account acting as a page hits the
        -- moment it belongs to a server no person has joined.
        --
        -- Same shape as the sibling queries below, which already COALESCE.
        COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'userID', COALESCE(ua.username, mr.slug, mb.handle, mr.realm_id)
        ))
        FROM community_member cm2
        LEFT JOIN user_account ua ON cm2.entity_id = ua.entity_id
        LEFT JOIN community_realm mr ON cm2.entity_id = mr.entity_id
        LEFT JOIN bot_bot mb ON cm2.entity_id = mb.entity_id
        WHERE cm2.realm_id = cr.realm_id
        ), '[]'::jsonb) AS members
    FROM community_realm cr
    JOIN community_member cm ON cr.realm_id = cm.realm_id
    WHERE cm.entity_id = $1
        AND cr.type = 'server'
    GROUP BY cr.id, cr.entity_id, cr.realm_id, cr.name, cr.profile, cr.created_by_id, cr.is_private, cr.type;
    `,
      [entity_id],
    );

    const encodedResult = createJWT(transformServersData(rows));
    res.send({ status: true, result: encodedResult });
  } catch (ex) {
    // This route had no handler at all, which is why the failure above
    // presented as a HANG rather than an error: Express 4 does not catch a
    // rejected async handler, so the throw became an unhandled rejection and
    // the request was left open until the client timed out. Same shape as the
    // sibling routes in this file.
    console.log(ex);
    res
      .status(400)
      .send({ status: false, message: ex.message || ex.toString() });
  }
});

router.get(
  "/initserversetup/:parent_realm/:conversationID",
  jwtchecker,
  async (req, res) => {
    const userID = req.params.userID;
    const id = req.params.id;
    const entityID = req.params.entity_id;
    const conversationID = req.params.conversationID;
    const parent_realm = req.params.parent_realm;

    await UserMessage.aggregate([
      {
        $match: {
          $and: [
            { receivers: { $in: [entityID] } },
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
          // receivers can be personal accounts (bulk-add-by-admin) or a
          // switched-to realm/page entity (self-join) - user_account only
          // has rows for the former, so anchor on entity_entity and
          // left-join all three detail tables (same pattern as GetAllReceivers
          // in reusables/models/messages.js) rather than filtering realm
          // entities out entirely.
          const { rows } = await pool.query(
            `
          SELECT
            p.id AS "entityID",
            COALESCE(u.id, r.id, b.id) AS "_id",
            COALESCE(u.username, r.slug, b.handle) AS "userID",
            json_build_object(
              'firstName', COALESCE(u.first_name, r.name, b.name),
              'middleName', COALESCE(u.middle_name, 'N/A'),
              'lastName', COALESCE(u.last_name, '')
            ) AS fullname,
            COALESCE(u.profile, r.profile, b.profile) AS profile
          FROM entity_entity p
          LEFT JOIN user_account u ON u.entity_id = p.id AND p.type = 'user'
          LEFT JOIN community_realm r ON r.entity_id = p.id AND p.type = 'realm'
          LEFT JOIN bot_bot b ON b.entity_id = p.id AND p.type = 'bot'
          WHERE p.id = ANY($1)`,
            [receivers_list],
          );

          rows_final = rows;
        } else {
          const { rows } = await pool.query(
            `
            SELECT
                p.id AS "entityID",
                COALESCE(u.id, r.id, b.id) AS "_id",
                COALESCE(u.username, r.slug, b.handle) AS "userID",
                json_build_object(
                  'firstName', COALESCE(u.first_name, r.name, b.name),
                  'middleName', COALESCE(u.middle_name, 'N/A'),
                  'lastName', COALESCE(u.last_name, '')
                ) AS fullname,
                COALESCE(u.profile, r.profile, b.profile) AS profile
            FROM community_member cm
            JOIN community_realm cr ON cm.realm_id = cr.realm_id
            JOIN entity_entity p ON cm.entity_id = p.id
            LEFT JOIN user_account u ON u.entity_id = p.id AND p.type = 'user'
            LEFT JOIN community_realm r ON r.entity_id = p.id AND p.type = 'realm'
            LEFT JOIN bot_bot b ON b.entity_id = p.id AND p.type = 'bot'
            WHERE cr.realm_id = $1 AND cr.parent_id = $2;`,
            [conversationID, parent_realm],
          );

          rows_final = rows;
        }

        if (
          rows_final.filter((flt) => flt.entityID === entityID).length === 0
        ) {
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
            'entityID', cr.entity_id,
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
            'type', cr.type,
            'is_admin', (
              pcr.entity_id = $3
              OR EXISTS (
                SELECT 1
                FROM community_member cm
                WHERE cm.entity_id = $3
                  AND cm.realm_id = pcr.realm_id
                  AND cm.role IN ('admin', 'owner')
              )
            )
          ) AS groupdetails,
          json_build_object(
            '_id', pcr.id,
            'entityID', pcr.entity_id,
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
            -- Entity-generic, matching the sibling query above. This was an
            -- INNER JOIN to user_account, which dropped every member that is
            -- not a person: a PAGE (community_member.entity_id can be a realm)
            -- and now a BOT. The row simply vanished from the roster rather
            -- than rendering wrong, which is why it went unnoticed.
            'members', COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'userID', COALESCE(cm_ua.username, cm_mr.slug, cm_mb.handle,
                                   cm_mr.realm_id)
              ))
              FROM community_member cm
              LEFT JOIN user_account cm_ua ON cm.entity_id = cm_ua.entity_id
              LEFT JOIN community_realm cm_mr ON cm.entity_id = cm_mr.entity_id
              LEFT JOIN bot_bot cm_mb ON cm.entity_id = cm_mb.entity_id
              WHERE cm.realm_id = pcr.realm_id
            ), '[]'::jsonb),
            'createdBy', pua.username,
            'privacy', pcr.is_private
          ) AS serverdetails
        FROM community_realm cr
        LEFT JOIN user_account ua ON cr.created_by_id = ua.entity_id
        LEFT JOIN community_realm pcr ON cr.parent_id = pcr.realm_id
        LEFT JOIN user_account pua ON pcr.created_by_id = pua.entity_id
        WHERE cr.realm_id = $1 AND cr.parent_id = $2;;`,
          [conversationID, parent_realm, entityID],
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
  const entityID = req.params.entity_id;
  const serverID = req.params.serverID;

  // A page's own entity can never appear as a Member row of its own realm
  // (community_member only ever holds personal accounts) - so once switched
  // to act as this exact server, the Member lookup below would always miss
  // and wrongly deny access to its own channel list.
  const { rows: selfRealmRow } = await pool.query(
    `SELECT 1 FROM community_realm WHERE realm_id = $1 AND entity_id = $2`,
    [serverID, entityID],
  );

  if (selfRealmRow.length === 0) {
    const { rows: row } = await pool.query(
      `SELECT member_id FROM community_member WHERE entity_id = $1 AND realm_id = $2;`,
      [entityID, serverID],
    );

    if (row.length === 0) {
      res.status(401).send({
        status: false,
        message: "You do not have access to this realm",
      });
      return;
    }
  }

  const { rows } = await pool.query(
    `SELECT 
    json_build_object(
      '_id', cr.id,
      'entityID', cr.entity_id,
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
      -- Entity-generic; see the sibling query above. An INNER JOIN here
      -- dropped page members and would drop bot members too.
      'members', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'userID', COALESCE(cm_ua.username, cm_mr.slug, cm_mb.handle,
                              cm_mr.realm_id)
        ))
        FROM community_member cm
        LEFT JOIN user_account cm_ua ON cm.entity_id = cm_ua.entity_id
        LEFT JOIN community_realm cm_mr ON cm.entity_id = cm_mr.entity_id
        LEFT JOIN bot_bot cm_mb ON cm.entity_id = cm_mb.entity_id
        WHERE cm.realm_id = cr.realm_id
      ), '[]'::jsonb),
      'createdBy', pua.username,
      'privacy', cr.is_private,
      'is_admin', (
        cr.entity_id = $1
        OR EXISTS (
          SELECT 1
          FROM community_member cm
          WHERE cm.entity_id = $1
            AND cm.realm_id = cr.realm_id
            AND cm.role IN ('admin', 'owner')
        )
      ),
      'channels', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            '_id', pcr.realm_id,
            'entityID', cr.entity_id,
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
            'type', pcr.type,
            'privacy', pcr.is_private,
            'messages', jsonb_build_array(),
            'is_joined', EXISTS (
              SELECT 1
              FROM community_member cm
              WHERE cm.entity_id = $1
                AND cm.realm_id = pcr.realm_id
            )
          )
        )
        FROM community_realm pcr
        LEFT JOIN user_account ppua ON pcr.created_by_id = ppua.entity_id
        WHERE pcr.parent_id = cr.realm_id
      ), '[]'::jsonb),
      -- Members are ENTITIES: a page can be a member of a server/channel.
      -- This used to INNER JOIN user_account, which dropped every realm
      -- member outright - so pages never appeared in the members list or in
      -- the create-channel picker. Anchored on entity_entity, with a realm's
      -- name/slug mapped onto the same user-shaped keys the clients already
      -- read (middleName 'N/A' is the sentinel they skip when composing a
      -- full name. Now also includes bots.
      'usersWithInfo', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          '_id', COALESCE(cmu.id, cmr.id, cmb.id),
          'entityID', p.id,
          'userID', COALESCE(cmu.username, cmr.slug, cmr.realm_id, cmb.handle),
          'fullname', CASE
            WHEN p.type = 'realm' THEN jsonb_build_object(
              'firstName', cmr.name,
              'middleName', 'N/A',
              'lastName', ''
            )
            WHEN p.type = 'bot' THEN jsonb_build_object(
              'firstName', cmb.name,
              'middleName', 'N/A',
              'lastName', ''
            )
            ELSE jsonb_build_object(
              'firstName', cmu.first_name,
              'middleName', cmu.middle_name,
              'lastName', cmu.last_name
            )
          END,
          'profile',
            CASE
              WHEN COALESCE(cmu.profile, cmr.profile, cmb.profile) IN ('N/A', 'none') THEN 'none'
              ELSE COALESCE(cmu.profile, cmr.profile, cmb.profile, 'none')
            END,
          -- An ACCOUNT's badge is is_badged; a REALM's and a BOT's are both
          -- is_verified. This list showed no badge at all before.
          'isVerified', COALESCE(cmu.is_badged, cmr.is_verified, cmb.is_verified, FALSE),
          -- The kind, so the member rows and the create-channel picker can
          -- mark a page as a page and a bot as a bot instead of showing three
          -- different kinds of entity as identical people.
          'entityType', p.type,
          'realmType', cmr.type
        ))
        FROM community_member cm
        JOIN entity_entity p ON p.id = cm.entity_id
        LEFT JOIN user_account   cmu ON cmu.entity_id = p.id AND p.type = 'user'
        LEFT JOIN community_realm cmr ON cmr.entity_id = p.id AND p.type = 'realm'
        LEFT JOIN bot_bot        cmb ON cmb.entity_id = p.id AND p.type = 'bot'
        WHERE cm.realm_id = cr.realm_id
      ), '[]'::jsonb)
    )
  FROM community_realm cr
  LEFT JOIN user_account pua ON cr.created_by_id = pua.entity_id
  WHERE cr.realm_id = $2;`,
    [entityID, serverID],
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
        seeners: { $nin: [entityID] },
      },
    },
    { $group: { _id: "$conversationID", unreadCount: { $sum: 1 } } },
  ])
    .then(async (result) => {
      // console.log(result);
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
  const entityID = req.params.entity_id;
  const username = req.params.username;
  const token = req.body.token;

  try {
    const decodedToken = jwt.verify(token, JWT_SECRET);
    const serverID = decodedToken.serverID;
    const memberstoadd = decodedToken.memberstoadd;

    const isrealmpub = await isRealmPublic(serverID);

    if (!isrealmpub) {
      await isRealmMember(serverID, entityID);
    }

    // A realm's own entity can never be a Member of its own realm - the
    // self-administration permission check (isRealmMember/hasPermission)
    // already resolves that entity as owner-tier directly, so inserting a
    // literal Member row for it would create a second, conflicting source
    // of truth for the same realm's ownership. Block it explicitly rather
    // than letting it silently no-op via ON CONFLICT DO NOTHING below.
    const { rows: realmRow } = await pool.query(
      `SELECT entity_id FROM community_realm WHERE realm_id = $1`,
      [serverID],
    );
    const realmEntityId = realmRow.length > 0 ? realmRow[0].entity_id : null;

    if (
      realmEntityId &&
      memberstoadd.some((mp) => mp.entityID === realmEntityId)
    ) {
      res.status(400).send({
        status: false,
        message: "A realm cannot join itself.",
      });
      return;
    }

    // memberstoadd can hold either personal accounts (bulk-add-by-admin) or
    // a switched-to realm/page entity (self-join) - user_account only has
    // rows for the former, so anchor on entity_entity and left-join both
    // detail tables (same pattern as GetAllReceivers in
    // reusables/models/messages.js) rather than filtering realm entities
    // out entirely.
    const { rows } = await pool.query(
      `
          SELECT
            p.id AS "entityID",
            COALESCE(u.username, r.slug, b.handle) AS "userID",
            EXISTS (
              SELECT 1
              FROM community_member cm
              WHERE cm.entity_id = p.id
                AND cm.realm_id = $2
            ) AS "alreadyMember"
          FROM entity_entity p
          LEFT JOIN user_account u ON u.entity_id = p.id AND p.type = 'user'
          LEFT JOIN community_realm r ON r.entity_id = p.id AND p.type = 'realm'
          LEFT JOIN bot_bot b ON b.entity_id = p.id AND p.type = 'bot'
          WHERE p.id = ANY($1);
        `,
      [memberstoadd.map((mp) => mp.entityID), serverID],
    );

    const ServerChannelsList = await GetServerChannels(serverID, false);
    const mappedGroupID = ServerChannelsList.map((mp) => ({
      groupID: mp.groupID,
      type: mp.type,
    }));

    const removeAlreadyJoined = rows.filter((flt) => !flt.alreadyMember);

    // Falsy entries dropped: a PAGE has no account id, and the clients build
    // this list from one - so a page self-joining or being added sent [""]
    // through, which then reached the SSE fan-out and the push targets as an
    // empty receiver. The resolved entity ids are added because they are the
    // ones that must be told either way, and they come from the database rather
    // than from the request body.
    const receivers = [
      ...new Set([
        ...(decodedToken.receivers || []).filter(Boolean),
        ...removeAlreadyJoined.map((mp) => mp.entityID),
      ]),
    ];

    // Awaited, all of it. These used to be fired and forgotten - the server-level
    // call with no await at all, the per-channel ones inside a `.map(async)` with
    // nothing collecting the promises - so the response went out before any
    // membership row existed and a failure could only ever surface in the logs.
    // That is also why a client refetching immediately after a successful add
    // could get a list without the new member in it.
    await AddNewMemberToChannels(
      entityID,
      username,
      {
        conversationID: serverID,
        memberstoadd: removeAlreadyJoined,
        receivers,
      },
      "server",
    );

    await Promise.all(
      mappedGroupID.map((mp) =>
        AddNewMemberToChannels(
          entityID,
          username,
          {
            conversationID: mp.groupID,
            memberstoadd: removeAlreadyJoined,
            receivers,
          },
          // The channel's REAL type, so a voice room is recognised as one and
          // gets membership without a system message (AddNewMemberToChannels
          // skips those, and NotificationMessageForConversations now refuses
          // them outright).
          mp.type,
        ),
      ),
    );

    // Realtime: the new members need this server in their rail, and everyone
    // already in it needs the member list to move. Nothing else says so - a
    // join writes membership rows and (for text channels) a system message
    // into channels the joiner is only now able to read, so the people who
    // matter here are precisely the ones no existing event reaches.
    //
    // Published after the AddNewMemberToChannels calls above are awaited, so a
    // client refetching on this reads rows that exist. Failures are logged
    // rather than thrown: the join itself has already succeeded, and a dropped
    // notification is not a reason to tell the caller otherwise.
    try {
      const joinedEntityIds = removeAlreadyJoined.map((mp) => mp.entityID);

      if (joinedEntityIds.length > 0) {
        const { rows: currentMembers } = await pool.query(
          `SELECT entity_id FROM community_member WHERE realm_id = $1;`,
          [serverID],
        );

        const targets = [
          ...new Set([
            ...joinedEntityIds,
            ...currentMembers.map((mp) => mp.entity_id),
          ]),
        ];

        targets.forEach((rcp) => {
          publish(`events_${rcp}`, "realm_membership_changed", {
            status: true,
            auth: true,
            message: `Members joined realm ${serverID}`,
            result: {
              realm_id: serverID,
              type: "server",
              action: "joined",
              entity_ids: joinedEntityIds,
            },
          });
        });
      }
    } catch (publishErr) {
      console.log("Failed to broadcast server join:", publishErr);
    }

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
  const entityID = req.params.entity_id;
  const realm_id = req.body.realm_id;
  const member_id = req.body.member_id;
  const new_role = req.body.new_role;

  try {
    if (
      !(await hasPermission(entityID, "realm.member.role.update", realm_id))
    ) {
      res.status(401).send({
        status: false,
        message: "You are not authorized to do this action",
      });
      return;
    }

    // Setting someone as owner would create a second owner alongside the
    // existing one - that's an ownership transfer (realm.ownership.transfer),
    // not a plain role update, and isn't implemented via this endpoint yet.
    if (new_role === "owner") {
      res.status(400).send({
        status: false,
        message: "Use ownership transfer to change the realm owner.",
      });
      return;
    }

    // Target-role-aware rule: an admin can change a plain member/moderator's
    // role, but only the owner can change a fellow admin's (or the owner's).
    // A page's own entity can never appear as a Member row of its own realm,
    // so once switched to act as this exact realm, resolve as owner tier
    // directly instead of letting the lookup below miss and wrongly deny it.
    const { rows: selfRealmActorRow } = await pool.query(
      `SELECT 1 FROM community_realm WHERE realm_id = $1 AND entity_id = $2`,
      [realm_id, entityID],
    );
    let actorRole;
    if (selfRealmActorRow.length > 0) {
      actorRole = "owner";
    } else {
      const { rows: actorRow } = await pool.query(
        `SELECT role FROM community_member WHERE entity_id = $1 AND realm_id = $2`,
        [entityID, realm_id],
      );
      actorRole = actorRow.length > 0 ? actorRow[0].role : null;
    }

    if (actorRole !== "owner") {
      const { rows: targetRow } = await pool.query(
        `SELECT role FROM community_member WHERE member_id = $1 AND realm_id = $2`,
        [member_id, realm_id],
      );
      if (
        targetRow.length > 0 &&
        ["admin", "owner"].includes(targetRow[0].role)
      ) {
        res.status(401).send({
          status: false,
          message: "Only the realm owner can change an admin's role.",
        });
        return;
      }
    }

    await pool.query(
      `UPDATE community_member SET role = $1 WHERE realm_id = $2 AND member_id = $3;`,
      [new_role, realm_id, member_id],
    );

    // Realtime: signal every member of the realm that the members list
    // changed so conference clients refetch it (roles, permissions). The
    // event carries no member data — the client pulls the full list via API.
    try {
      const { rows: realmMembers } = await pool.query(
        `SELECT entity_id FROM community_member WHERE realm_id = $1;`,
        [realm_id],
      );

      const changedPayload = {
        status: true,
        auth: true,
        realm_id,
      };

      realmMembers.forEach((mp) => {
        publish(
          `events_${mp.entity_id}`,
          "conference_members_changed",
          changedPayload,
        );
      });
    } catch (publishErr) {
      console.log("Failed to broadcast member change:", publishErr);
    }

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

// Ownership transfer: promote a member to owner and step the current owner
// down to admin. Deliberately NOT part of /update-member-realm-role, which
// refuses new_role === "owner" precisely because "set someone to owner" and
// "hand over the realm" are different operations - the second one must also
// demote whoever holds it now, or the realm ends up with two owners.
//
// realm.ownership.transfer is owner-exclusive in the seeded role matrix
// (entity/migrations/0004_seed_permission_catalog.py), so hasPermission alone
// enforces "only the owner may do this" - no extra actor-role check needed,
// unlike the remove/re-role routes where admins hold the base permission too.
router.put("/transfer-realm-ownership", jwtchecker, async (req, res) => {
  const entityID = req.params.entity_id;
  const realm_id = req.body.realm_id;
  const member_id = req.body.member_id;

  try {
    if (
      !(await hasPermission(entityID, "realm.ownership.transfer", realm_id))
    ) {
      res.status(401).send({
        status: false,
        message: "Only the realm owner can transfer ownership",
      });
      return;
    }

    const { rows: targetRows } = await pool.query(
      `SELECT entity_id, role FROM community_member WHERE member_id = $1 AND realm_id = $2`,
      [member_id, realm_id],
    );

    if (targetRows.length === 0) {
      res.status(400).send({
        status: false,
        message: "That member is not part of this realm",
      });
      return;
    }

    if (targetRows[0].role === "owner") {
      res.status(400).send({
        status: false,
        message: "They already own this realm",
      });
      return;
    }

    // One statement rather than two updates in a transaction: getPool()
    // hands back the POOL, not a pinned client, so BEGIN/COMMIT issued
    // through it can land on different connections. A single UPDATE is
    // atomic on its own and cannot leave the realm with two owners (or
    // none) if the process dies mid-way.
    //
    // The actor has no row to demote when acting AS the realm itself - a
    // realm's own entity is never a Member of its own realm - and the WHERE
    // simply matches one row instead of two. That actor keeps owner tier
    // regardless, which is correct: it IS the realm.
    await pool.query(
      `UPDATE community_member
          SET role = CASE
                       WHEN member_id = $1 THEN 'owner'
                       WHEN entity_id = $2 THEN 'admin'
                       ELSE role
                     END
        WHERE realm_id = $3
          AND (member_id = $1 OR entity_id = $2)`,
      [member_id, entityID, realm_id],
    );

    // Same broadcast the role update sends: roles changed, so every client
    // holding a members list needs to refetch it.
    try {
      const { rows: realmMembers } = await pool.query(
        `SELECT entity_id FROM community_member WHERE realm_id = $1;`,
        [realm_id],
      );

      const changedPayload = {
        status: true,
        auth: true,
        realm_id,
      };

      realmMembers.forEach((mp) => {
        publish(
          `events_${mp.entity_id}`,
          "conference_members_changed",
          changedPayload,
        );
      });
    } catch (publishErr) {
      console.log("Failed to broadcast member change:", publishErr);
    }

    res.send({
      status: true,
      message: "Ownership transferred",
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
