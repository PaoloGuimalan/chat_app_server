const UserContacts = require("../../schema/users/contacts");
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

const GetListOfContactsV2 = async (userID) => {
  const { rows } = await pool.query(
    `
    SELECT DISTINCT
      c.connection_id,
      c.action_date
    FROM user_connection c
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
    FROM user_connection c
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
        FROM user_connection
        WHERE connection_id = ANY($1)

        UNION

        SELECT involved_user_id AS user_id
        FROM user_connection
        WHERE connection_id = ANY($1)
      ) AS combined_users;
    `,
    [connectionIDs],
  );

  return rows.map((r) => r.user_id);
};

const GetUsersWithConnectionIDs = async (connectionIDs) => {
  const { rows } = await pool.query(
    `
      SELECT
        entity_id,
        json_agg(DISTINCT connection_id) AS connection_ids
      FROM (
        SELECT
          action_by_id AS entity_id,
          connection_id
        FROM user_connection
        WHERE connection_id = ANY($1::TEXT[])

        UNION ALL

        SELECT
          involved_entity_id AS entity_id,
          connection_id
        FROM user_connection
        WHERE connection_id = ANY($1::TEXT[])
      ) AS combined
      GROUP BY entity_id;
    `,
    [connectionIDs],
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
};
