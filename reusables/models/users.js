const UserContacts = require("../../schema/users/contacts");
const Conversation = require("../../schema/messages/conversation");
const pool = require("../../reusables/database/postgres");
const crypto = require("crypto");

const GetListOfContacts = async (userID) => {
  return await UserContacts.aggregate([
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
  ])
    .then((result) => {
      // console.log(result)
      const finalfilt = result
        .filter((flt) => flt.type === "single")
        .map((mp) => {
          if (mp.userdetails.userone.userID === userID) {
            return mp.userdetails.usertwo.userID;
          } else {
            return mp.userdetails.userone.userID;
          }
        });
      return finalfilt;
    })
    .catch((err) => {
      // console.log(err)
      throw new Error(err);
    });
};

const GetSenderDetails = async (entity_id) => {
  const { rows } = await pool.query(
    `SELECT 'user' AS entity_type,
            username AS handle,
            TRIM(CONCAT(first_name, ' ', last_name)) AS display_name,
            NULLIF(NULLIF(profile, 'none'), 'N/A') AS profile
       FROM user_account
      WHERE entity_id = $1
      UNION ALL
     SELECT 'realm' AS entity_type,
            slug AS handle,
            name AS display_name,
            NULLIF(NULLIF(profile, 'none'), 'N/A') AS profile
       FROM community_realm
      WHERE entity_id = $1
      LIMIT 1;`,
    [entity_id],
  );

  return rows[0] || null;
};

/**
 * Handles for many entities at once, as a Map keyed by entity_id.
 *
 * Same user-or-realm union as GetSenderDetails, but batched - the callers are
 * loops over members being added or removed, where calling the single-entity
 * version per member would be one round trip each.
 *
 * Entities that resolve to neither table are simply absent from the Map, so
 * callers should fall back rather than assume a hit.
 */
const GetEntityHandles = async (entity_ids = []) => {
  const ids = [...new Set((entity_ids || []).filter(Boolean).map(String))];
  if (!ids.length) return new Map();

  const { rows } = await pool.query(
    `SELECT entity_id,
            'user' AS entity_type,
            username AS handle,
            TRIM(CONCAT(first_name, ' ', last_name)) AS display_name
       FROM user_account
      WHERE entity_id = ANY($1::text[])
      UNION ALL
     SELECT entity_id,
            'realm' AS entity_type,
            slug AS handle,
            name AS display_name
       FROM community_realm
      WHERE entity_id = ANY($1::text[]);`,
    [ids],
  );

  return new Map(rows.map((r) => [String(r.entity_id), r]));
};

const GetListOfContactsV2 = async (userID) => {
  const { rows } = await pool.query(
    `
    SELECT DISTINCT
      c.connection_id,
      c.action_date
    FROM entity_connection c
    JOIN user_account ab ON c.action_by_id = ab.id
    JOIN user_account iu ON c.involved_user_id = iu.id
    WHERE
        (ab.id = $1 OR iu.id = $1)
        AND ab.id != iu.id
        AND ab.is_active = TRUE
        AND ab.is_verified = TRUE
        AND iu.is_active = TRUE
        AND iu.is_verified = TRUE
        AND c.status = TRUE
    ORDER BY c.action_date DESC, c.connection_id ASC;
  `,
    [userID],
  );

  return rows.map((mp) => mp.connection_id);
};

const GetRankedUsersInConnections = async (entityID, limit = 500) => {
  const query = `
    SELECT DISTINCT ON (c.connection_id)
      c.action_by_id,
      c.involved_entity_id,
      c.interaction_score,
      c.last_interaction_at
    FROM entity_connection c
    JOIN user_account ab ON c.action_by_id = ab.entity_id
    JOIN user_account iu ON c.involved_entity_id = iu.entity_id
    WHERE
      (ab.entity_id = $1 OR iu.entity_id = $1)
      AND ab.entity_id != iu.entity_id
      AND ab.is_active = TRUE
      AND ab.is_verified = TRUE
      AND iu.is_active = TRUE
      AND iu.is_verified = TRUE
      AND c.status = TRUE
    ORDER BY 
      c.connection_id, 
      c.interaction_score DESC, 
      c.last_interaction_at DESC;
  `;

  const { rows } = await pool.query(query, [entityID]);

  const sortedRows = rows.sort((a, b) => {
    if (b.interaction_score !== a.interaction_score) {
      return b.interaction_score - a.interaction_score;
    }
    return new Date(b.last_interaction_at) - new Date(a.last_interaction_at);
  });

  const uniqueValues = [];
  const seen = new Set();

  for (const row of sortedRows) {
    const targetID =
      row.action_by_id === entityID ? row.involved_entity_id : row.action_by_id;

    if (targetID !== entityID && !seen.has(targetID)) {
      uniqueValues.push(targetID);
      seen.add(targetID);
    }

    if (uniqueValues.length >= limit) break;
  }

  return uniqueValues;
};

const GetUsersFromConnections = async (connectionIDs) => {
  const { rows } = await pool.query(
    `
      SELECT DISTINCT user_id
      FROM (
        SELECT action_by_id AS user_id
        FROM entity_connection
        WHERE connection_id = ANY($1)

        UNION

        SELECT involved_user_id AS user_id
        FROM entity_connection
        WHERE connection_id = ANY($1)
      ) AS combined_users;
    `,
    [connectionIDs],
  );

  return rows.map((r) => r.user_id);
};

// Batched GetAllReceivers: resolves the participants of MANY conversations at
// once, keyed per conversation. Mirrors GetAllReceivers' entity-generic
// resolution - anchor on entity_entity and LEFT JOIN both user_account and
// community_realm so a user<->realm (page) counterpart resolves instead of
// being dropped by a user_account-only lookup - and its participant sources:
//   1. entity_connection      - conversations backed by a connection.
//   2. participant_ids (Mongo) - conversations not connected yet, or where a
//      participant only lives on the conversation doc.
// GetAllReceivers falls back between these for a single id; here they are
// UNION-ed (then deduped) so a batch resolves completely in one round-trip.
// Returns [{ conversationID, users: [{ _id, entityID, userID, fullname,
// profile }] }].
const GetUsersWithConnectionIDs = async (connectionIDs) => {
  // Pull participant_ids straight from the Mongo conversation docs and flatten
  // into parallel (conversationID, entity_id) arrays for the SQL UNNEST below.
  const conversationDocs = connectionIDs.length
    ? await Conversation.find(
        { conversationID: { $in: connectionIDs } },
        { conversationID: 1, participant_ids: 1 },
      )
    : [];

  const participantConvIDs = [];
  const participantEntityIDs = [];
  for (const doc of conversationDocs) {
    for (const pid of doc.participant_ids || []) {
      participantConvIDs.push(String(doc.conversationID));
      participantEntityIDs.push(String(pid));
    }
  }

  const { rows } = await pool.query(
    `
      SELECT
        combined.conversation_id AS "conversationID",
        jsonb_agg(
          jsonb_build_object(
            '_id', COALESCE(u.id, r.id),
            'entityID', p.id,
            'userID', COALESCE(u.username, r.slug),
            'fullname', CASE
              WHEN p.type = 'realm' THEN jsonb_build_object(
                'firstName', r.name,
                'middleName', '',
                'lastName', ''
              )
              ELSE jsonb_build_object(
                'firstName', u.first_name,
                'middleName', u.middle_name,
                'lastName', u.last_name
              )
            END,
            'profile', COALESCE(u.profile, r.profile, 'none')
          )
        ) AS users
      FROM (
        SELECT action_by_id AS entity_id, connection_id AS conversation_id
        FROM entity_connection
        WHERE connection_id = ANY($1::TEXT[])

        UNION

        SELECT involved_entity_id AS entity_id, connection_id AS conversation_id
        FROM entity_connection
        WHERE connection_id = ANY($1::TEXT[])

        UNION

        SELECT t.entity_id, t.conversation_id
        FROM UNNEST($2::TEXT[], $3::TEXT[]) AS t(conversation_id, entity_id)
      ) AS combined
      JOIN entity_entity p ON p.id = combined.entity_id
      LEFT JOIN user_account u ON u.entity_id = p.id AND p.type = 'user'
      LEFT JOIN community_realm r ON r.entity_id = p.id AND p.type = 'realm'
      GROUP BY combined.conversation_id;
    `,
    [connectionIDs, participantConvIDs, participantEntityIDs],
  );

  return rows;
};

async function CreateEntity(type) {
  // Validate incoming parameter safely before sending to the database instance
  if (!type) {
    throw new Error(
      "Entity classification type parameter is strictly required.",
    );
  }

  const queryText = `
    INSERT INTO entity_entity (id, type, created_at)
    VALUES ($1, $2, NOW())
    RETURNING id, type, created_at;
  `;

  // Explicitly generate a UUID v4 string to match Django's model default action pattern
  const entityId = crypto.randomUUID();
  const values = [entityId, type];

  try {
    const { rows } = await pool.query(queryText, values);

    // Returns the newly generated row object index directly
    return rows[0].id;
  } catch (error) {
    console.error("Database layer failure creating entity row:", error);
    throw error;
  }
}

module.exports = {
  GetListOfContacts,
  GetListOfContactsV2,
  GetUsersFromConnections,
  GetUsersWithConnectionIDs,
  GetRankedUsersInConnections,
  CreateEntity,
  GetSenderDetails,
  GetEntityHandles,
};
