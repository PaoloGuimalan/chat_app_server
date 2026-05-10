const { types } = require("cassandra-driver");
const pool = require("../../reusables/database/postgres");
const { connect } = require("../database/cassandra");
const { bumpLock } = require("../redis/pubsub");

const INTERACTION_WEIGHTS = {
  NEW_CONNECTION: 10.0,
  SHARE: 7.0,
  REPOST: 7.0,
  CHAT: 3.0,
  COMMENT: 4.0,
  LIKE: 1.0,
  VIEW: 0.1,
  PROFILE_VISIT: 0.5,
};

/**
 * Updates interaction scores in Postgres and syncs the change to Cassandra feed cache.
 */
const interactionScoreBump = async (
  actorID,
  receiverID,
  action,
  isDecrease,
) => {
  if (actorID === receiverID) return;

  const weight = INTERACTION_WEIGHTS[action] || 0.0;
  const change = isDecrease ? -weight : weight;
  const now = new Date();

  try {
    await pool.query("BEGIN");

    // 1. Find and Update Postgres Connections
    const { rows } = await pool.query(
      `
      SELECT * FROM user_connection
      WHERE (action_by_id = $1 AND involved_user_id = $2)
         OR (action_by_id = $2 AND involved_user_id = $1);
    `,
      [actorID, receiverID],
    );

    const uniqueConnectionIDs = [
      ...new Set(rows.map((row) => row.connection_id)),
    ];

    if (uniqueConnectionIDs.length > 0) {
      const updateRes = await pool.query(
        `
            UPDATE user_connection
            SET 
                interaction_score = interaction_score + $1,
                last_interaction_at = $2
            WHERE connection_id = ANY($3)
            RETURNING connection_id;
            `,
        [change, now, uniqueConnectionIDs],
      );
    }

    await pool.query("COMMIT");
  } catch (e) {
    await pool.query("ROLLBACK");
    throw e;
  }
};

const bumpChatScore = async (conversationID, memberIDs, actorID) => {
  const lock_key = `chatterloop:bump_lock:${conversationID}:chat`;

  // 1. Try to set the key in Redis ONLY if it doesn't exist (NX)
  // with an expiry of 1800 seconds (30 mins)
  const isLocked = await bumpLock(lock_key);

  if (isLocked) {
    memberIDs.map(async (mp) => {
      await interactionScoreBump(actorID, mp, "CHAT", false);
    });
  }
};

const followerInteractionScoreBump = async (
  actorID,
  receiverID,
  action,
  isDecrease,
) => {
  if (!receiverID) return;

  const weight = INTERACTION_WEIGHTS[action] || 0.0;
  const change = isDecrease ? -weight : weight;
  const now = new Date();

  try {
    await pool.query("BEGIN");

    const { rows } = await pool.query(
      `
      SELECT * FROM community_realmfollow
      WHERE follower_id = $1 AND realm_id = $2;
    `,
      [actorID, receiverID],
    );

    const followIDs = [...new Set(rows.map((row) => row.follow_id))];

    if (followIDs.length > 0) {
      const updateRes = await pool.query(
        `
            UPDATE community_realmfollow
            SET 
                interaction_score = interaction_score + $1,
                last_interaction_at = $2
            WHERE follower_id = $3 AND realm_id = $4;
            `,
        [change, now, actorID, receiverID],
      );
    }

    await pool.query("COMMIT");
  } catch (e) {
    await pool.query("ROLLBACK");
    throw e;
  }
};

const bulkFanoutToCache = async (connectionsList, postData, type) => {
  const client = await connect();

  const queries = connectionsList.map((followerId) => ({
    query: `
      INSERT INTO chatterloop.newsfeed_index (
        bucket, 
        post_id, 
        created_at, 
        author_id,
        type
      ) VALUES (?, ?, ?, ?, ?)
    `,
    params: [
      String(followerId),
      String(postData.id),
      new Date(),
      String(postData.author_id),
      type,
    ],
  }));

  const chunkSize = 50;
  for (let i = 0; i < queries.length; i += chunkSize) {
    const batch = queries.slice(i, i + chunkSize);

    await client.batch(batch, {
      prepare: true,
      logged: false,
    });
  }
};

module.exports = {
  interactionScoreBump,
  followerInteractionScoreBump,
  bulkFanoutToCache,
  bumpChatScore,
};
