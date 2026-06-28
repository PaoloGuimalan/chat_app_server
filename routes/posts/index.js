require("dotenv").config();
const express = require("express");
const jwt = require("jsonwebtoken");
const cassandra = require("cassandra-driver");
const {
  sseNotificationsWaiters,
  SendTagPostNotification,
} = require("../../reusables/hooks/sse");
const dateGetter = require("../../reusables/hooks/getDate");
const timeGetter = require("../../reusables/hooks/getTime");
const makeID = require("../../reusables/hooks/makeID");
const { jwtchecker, createJWT } = require("../../reusables/hooks/jwthelper");
const { parseEntityId } = require("../../reusables/hooks/entity");
const { canActAsRealm } = require("../../reusables/models/realms");
const router = express.Router();

const Posts = require("../../schema/posts/posts");
const UserNotifications = require("../../schema/users/notifications");
const {
  checkPostIDExisting,
  GetAllPostsCountInProfile,
  updateRankingScore,
} = require("../../reusables/models/posts");
const { checkNotifID } = require("../../reusables/models/notifications");
const {
  uploadFirebaseMultiple,
  saveFileRecordToDatabase,
} = require("../../reusables/hooks/firebaseupload");
const {
  GetListOfContacts,
  GetRankedUsersInConnections,
} = require("../../reusables/models/users");
const {
  SEND_TAG_POST_NOTIFICATION,
} = require("../../reusables/vars/rabbitmqevents");
const producer = require("../../reusables/rabbitmq/producer");
const { publish } = require("../../reusables/redis/pubsub");
const pool = require("../../reusables/database/postgres");
const { generateUUID } = require("../../reusables/hooks/transformers");

const Storage = require("../../reusables/hooks/storage");
const { query } = require("../../reusables/database/cassandra");
const {
  interactionScoreBump,
  followerInteractionScoreBump,
  bulkFanoutToCache,
} = require("../../reusables/hooks/interactionscoring");

const JWT_SECRET = process.env.JWT_SECRET;

router.get("/preview/:postID", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const postID = req.params.postID;
  const contactslist = await GetListOfContacts(userID);

  // console.log(contactslist);

  await Posts.aggregate([
    //find({ userID: profileUserID }).sort({ _id: -1 }).limit(range)
    {
      $match: {
        $and: [
          {
            $or: [
              { userID: { $in: contactslist } },
              { "tagging.users": { $in: contactslist } },
              { "privacy.status": "public" },
              {
                $and: [
                  { "privacy.status": "filtered" },
                  { "privacy.users": userID },
                ],
              },
            ],
          },
          {
            postID: postID,
          },
        ],
      },
    },
    {
      $lookup: {
        from: "useraccount",
        localField: "tagging.users",
        foreignField: "userID",
        as: "tagged_users",
      },
    },
    {
      $lookup: {
        from: "useraccount",
        let: { userIDPass: "$userID" },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ["$userID", "$$userIDPass"] },
            },
          },
        ],
        as: "post_owner",
      },
    },
    {
      $unwind: "$post_owner",
    },
    {
      $sort: {
        _id: -1,
      },
    },
    {
      $project: {
        "tagged_users.dateCreated": 0,
        "tagged_users.email": 0,
        "tagged_users.password": 0,
        "post_owner.dateCreated": 0,
        "post_owner.email": 0,
        "post_owner.password": 0,
      },
    },
  ])
    .then((result) => {
      var posts = result;
      // console.log(result)
      const encodedResult = createJWT({
        preview: posts[0],
      });

      res.send({ status: true, result: encodedResult });
    })
    .catch((err) => {
      res.send({ status: false, message: err.message });
      console.log(err);
    });
});

router.get("/userposts/:profileUserID", jwtchecker, async (req, res) => {
  const profileUserID = req.params.profileUserID;
  const page = req.headers["page"];
  const range = req.headers["range"];
  const totalposts = await GetAllPostsCountInProfile(profileUserID);

  await Posts.aggregate([
    //find({ userID: profileUserID }).sort({ _id: -1 }).limit(range)
    {
      $match: {
        $or: [{ userID: profileUserID }, { "tagging.users": profileUserID }],
      },
    },
    {
      $lookup: {
        from: "useraccount",
        localField: "tagging.users",
        foreignField: "userID",
        as: "tagged_users",
      },
    },
    {
      $lookup: {
        from: "useraccount",
        let: { userIDPass: "$userID" },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ["$userID", "$$userIDPass"] },
            },
          },
        ],
        as: "post_owner",
      },
    },
    {
      $unwind: "$post_owner",
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
    {
      $project: {
        "tagged_users.dateCreated": 0,
        "tagged_users.email": 0,
        "tagged_users.password": 0,
        "post_owner.dateCreated": 0,
        "post_owner.email": 0,
        "post_owner.password": 0,
      },
    },
  ])
    .then((result) => {
      var posts = result;
      // console.log(result)
      // const encodedResult = createJWT({
      //   posts: posts,
      //   total: totalposts,
      // });

      res.send({
        status: true,
        result: {
          posts: posts,
          total: totalposts,
        },
      });
    })
    .catch((err) => {
      res.send({ status: false, message: err.message });
      console.log(err);
    });
});

const notifyTaggedUser = async (userID, username, postID, tagged_users) => {
  tagged_users.map(async (mp) => {
    const awaitNotifID = await checkNotifID(`NTF_${makeID(20)}`);
    const notifParams = {
      notificationID: awaitNotifID,
      referenceID: postID,
      referenceStatus: false,
      toUserID: mp,
      fromUserID: userID,
      content: {
        headline: `You were tagged`,
        details: `@${username} tagged you on a post.`,
      },
      date: {
        date: dateGetter(),
        time: timeGetter(),
      },
      type: "tag_notification",
      isRead: false,
    };

    const newNotif = new UserNotifications(notifParams);

    newNotif
      .save()
      .then(async () => {
        SendTagPostNotification(`@${userID} tagged you on a post.`, mp);
      })
      .catch((err) => {
        console.log(err);
      });
  });
};

router.post("/upload", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const id = req.params.id;

  try {
    const body = req.body;
    const filereferencesraw = body.references;
    const filereferences = filereferencesraw.map((mp) => ({
      name: mp.name,
      caption: mp.caption,
      reference: mp.reference,
      referenceMediaType: mp.referenceMediaType,
      referenceID: id,
    }));

    // const finaluploadedreferences =
    //   await uploadFirebaseMultiple(filereferences);

    const finaluploadedreferences = await Storage.uploadMultipleBase64(
      filereferences,
      `uploads/entries/${id}`,
    );

    const savedFiles = await Promise.all(
      finaluploadedreferences.map((mp) =>
        saveFileRecordToDatabase(
          [mp.referenceID, `NTR_ATTCH_${makeID(20)}`],
          mp.reference,
          "entry",
          mp.referenceMediaType,
          "firebase",
          mp.name,
        ),
      ),
    );

    res.send({ status: true, result: savedFiles });
  } catch (ex) {
    console.error(ex);
    res.status(400).send({
      status: false,
      message: "Error processing request",
      details: ex.message,
    });
  }
});

router.post("/createpost", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const username = req.params.username;
  const id = req.params.id;
  const postID = await checkPostIDExisting(makeID(30));
  const currentTimestampInSeconds = Math.floor(Date.now() / 1000);

  const token = req.body.token;

  try {
    const decodeToken = jwt.verify(token, JWT_SECRET);
    const filereferencesraw = decodeToken.content.references;
    const content_type = decodeToken.type.contentType;
    const realm_id = decodeToken.realm_id;
    const filereferences = filereferencesraw.map((mp) => ({
      name: mp.name || `${postID}_${makeID(20)}`,
      caption: mp.caption,
      reference: mp.reference,
      referenceMediaType: mp.referenceMediaType,
      referenceID: `${postID}_${makeID(20)}`,
    }));

    const finaluploadedreferences = decodeToken.content.isShared
      ? filereferences
      : await Storage.uploadMultipleBase64(
          filereferences,
          `uploads/posts/${id}/${postID}`,
        );

    if (decodeToken.content.isShared) {
      finaluploadedreferences.forEach(async (mp) => {
        const { rows: query_post_user } = await pool.query(
          `SELECT 
                ua.username,
                ua.id 
            FROM 
                newsfeed_post np 
            JOIN 
                user_account ua  
            ON 
                np.user_id  = ua.id 
            WHERE
                np.post_id = $1
          `,
          [mp.reference],
        );

        if (query_post_user.length > 0) {
          const post_user = query_post_user[0].id;

          if (post_user !== userID) {
            interactionScoreBump(id, post_user, "SHARE", false);
            followerInteractionScoreBump(id, realm_id, "SHARE", false);

            const awaitNotifID = await checkNotifID(`NTF_${makeID(20)}`);
            const notifParams = {
              notificationID: awaitNotifID,
              referenceID: postID,
              referenceStatus: false,
              toUserID: post_user,
              fromUserID: userID,
              content: {
                headline: `Shared post`,
                details: `@${username} shared your post.`,
              },
              date: {
                date: dateGetter(),
                time: timeGetter(),
              },
              type: "shared_post_notification",
              isRead: false,
            };

            const newNotif = new UserNotifications(notifParams);
            newNotif
              .save()
              .then(() => {
                publish(`events_${post_user}`, `notifications`, {
                  status: true,
                  auth: true,
                  message: `@${username} shared your post.`,
                  result: "", //encodedResult
                });
              })
              .catch((err) => {
                console.log(err);
              });
          }

          await pool.query(
            `UPDATE newsfeed_postscore
            SET shares_count = shares_count + 1
            WHERE post_id = $1
          `,
            [mp.reference],
          );

          updateRankingScore(mp.reference, "share", false);
        }

        saveFileRecordToDatabase(
          [mp.referenceID],
          mp.reference,
          "post",
          mp.referenceMediaType,
          "firebase",
          mp.name,
        );
      });
    }

    // Resolve the post's actor entity: an explicit realm post (realm_id), else
    // the acting-as realm (X-Acting-As, re-validated), else the user. The realm
    // IS the author — there is no separate author_realm anymore.
    let actorRealmId = realm_id || null;
    if (!actorRealmId) {
      const actingAs = req.headers["x-acting-as"];
      const parsed = actingAs ? parseEntityId(actingAs) : { type: null };
      if (
        parsed.type === "realm" &&
        (await canActAsRealm(parsed.sourceId, id))
      ) {
        actorRealmId = parsed.sourceId;
      }
    }
    const actorEntityId = actorRealmId
      ? "entity:realm:" + actorRealmId
      : "entity:user:" + id;

    // Prepare main post insert
    const postInsertQuery = `
      INSERT INTO newsfeed_post (
        post_id, user_id, is_sponsored, is_live, on_feed, from_system, date_posted,
        is_shared, file_type, caption, content_type, is_tagged, privacy_status, actor_entity_id, acted_by_user_id, is_archived
      ) VALUES (
        $1, $2, $3, $4, $5, $6, to_timestamp($7),
        $8, $9, $10, $11, $12, $13, $14, $15, $16
      );
    `;
    const postValues = [
      postID,
      id,
      false, // isSponsored
      false, // isLive
      decodeToken.onfeed,
      true, // fromSystem
      currentTimestampInSeconds,
      decodeToken.content.isShared,
      decodeToken.type.fileType,
      decodeToken.content.data,
      decodeToken.type.contentType,
      decodeToken.tagging.isTagged,
      decodeToken.privacy.status,
      actorEntityId,
      id, // acted_by_user (the human)
      false,
    ];

    const client = await pool.getPool();

    try {
      await client.query("BEGIN");

      // Insert Post
      if (filereferences.length !== finaluploadedreferences.length) {
        throw new Error("Failed to create post!");
      }

      await client.query(postInsertQuery, postValues);

      // Batch insert post references
      if (finaluploadedreferences.length > 0) {
        if (content_type === "profile") {
          if (realm_id) {
            await pool.query(
              `UPDATE community_realm
                SET profile = $1
                WHERE realm_id = $2
              `,
              [finaluploadedreferences[0].reference, realm_id],
            );
          } else {
            await pool.query(
              `UPDATE user_account
                SET profile = $1
                WHERE id = $2
              `,
              [finaluploadedreferences[0].reference, userID],
            );
          }
        }

        if (content_type === "cover_photo") {
          if (realm_id) {
            await pool.query(
              `UPDATE community_realm
                SET cover_photo = $1
                WHERE realm_id = $2
              `,
              [finaluploadedreferences[0].reference, realm_id],
            );
          } else {
            await pool.query(
              `UPDATE user_account
                SET coverphoto = $1
                WHERE id = $2
              `,
              [finaluploadedreferences[0].reference, userID],
            );
          }
        }

        const refValues = [];
        const refRowsSql = finaluploadedreferences
          .map((ref, i) => {
            refValues.push(
              ref.referenceID,
              postID,
              ref.reference,
              ref.caption || null,
              ref.referenceMediaType,
              ref.name || null,
            );
            const baseIndex = i * 6;

            return `($${baseIndex + 1}, $${baseIndex + 2}, $${
              baseIndex + 3
            }, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6})`;
          })
          .join(", ");

        const refInsertQuery = `
          INSERT INTO newsfeed_postreference (reference_id, post_id, reference, caption, reference_media_type, reference_name)
          VALUES ${refRowsSql};
        `;

        await client.query(refInsertQuery, refValues);
      }

      if (
        decodeToken.tagging.isTagged &&
        decodeToken.tagging.users.length > 0
      ) {
        // Assume decodeToken.tagging.users contains usernames (or any identifier)
        const taggedUsernames = decodeToken.tagging.users;

        // Query user IDs for all tagged usernames
        const userQuery = `
          SELECT id, username
          FROM user_account
          WHERE username = ANY($1)
        `;

        const { rows: userRows } = await client.query(userQuery, [
          taggedUsernames,
        ]);

        // Map of username -> real user id
        const usernameToId = new Map(userRows.map((u) => [u.username, u.id]));

        // Prepare tagValues and tagRowsSQL with real user ids
        const tagValues = [];
        const tagRowsSQL = taggedUsernames
          .map((username, i) => {
            const postTagId = generateUUID();
            const userId = usernameToId.get(username);
            if (!userId) throw new Error(`Tagged user "${username}" not found`);
            tagValues.push(postTagId, postID, userId);
            const baseIndex = i * 3;
            return `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3})`;
          })
          .join(", ");

        const insertTagQuery = `
          INSERT INTO newsfeed_posttag (post_tag_id, post_id, user_id)
          VALUES ${tagRowsSQL};
        `;

        await client.query(insertTagQuery, tagValues);
      }

      const insertPreviewCountsQuery = `
        INSERT INTO newsfeed_previewcount (preview_id, post_id, emoji_id, count)
        SELECT gen_random_uuid(), $1, emoji_id, 0
        FROM newsfeed_emoji;
      `;

      await client.query(insertPreviewCountsQuery, [postID]);

      // const insertActivityCount = `
      //   INSERT INTO newsfeed_activitycount (count_id, count_type, count, post_id)
      //   VALUES
      //   (gen_random_uuid(), 'share', 0, $1),
      //   (gen_random_uuid(), 'comment', 0, $1);
      // `;

      // await client.query(insertActivityCount, [postID]);

      // POST SCORE TABLE SAVE

      let content_t_m = 1.0;

      if (filereferences.length > 0) {
        filereferences.map((mp) => {
          if (mp.referenceMediaType === "image") {
            content_t_m += 6.5;
          } else if (mp.referenceMediaType === "video") {
            content_t_m += 8.5;
          } else {
            content_t_m += 2.0;
          }
        });
      } else {
        content_t_m += 4.0;
      }

      const final_content_score = content_t_m / (filereferences.length + 1);

      const age_hours = currentTimestampInSeconds / (1000 * 60 * 60);
      const affinity_score = 1.0;
      const content_type_weight = final_content_score;
      const recent_update_boost = 1.0;
      const comments_count = 0;
      const likes_count = 0;
      const shares_count = 0;

      const base_engagement = 1;

      const weighted_engagement =
        comments_count * 3 +
        likes_count * 1 +
        shares_count * 5 +
        base_engagement;

      const decay_factor = (age_hours + 1) ** 0.5;
      const ranking_score =
        (weighted_engagement / decay_factor) *
        affinity_score *
        content_type_weight *
        recent_update_boost;

      const insertPostScore = `
        INSERT INTO newsfeed_postscore (affinity_score, content_type_weight, recent_update_boost, likes_count, comments_count, shares_count, ranking_score, post_id)
        VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8);
      `;

      await client.query(insertPostScore, [
        affinity_score,
        content_type_weight,
        recent_update_boost,
        likes_count,
        comments_count,
        shares_count,
        ranking_score,
        postID,
      ]);

      // END: POST SCORE TABLE SAVE

      // CASSANDRA FEED BUILDER

      //   const cassandra_feed_query = `
      //   INSERT INTO chatterloop.newsfeed_index (
      //     bucket,
      //     latest_activity,
      //     post_id,
      //     author_id,
      //     ranking_score
      //   ) VALUES (?, ?, ?, ?, ?)
      // `;

      //   const cassandra_feed_params = [
      //     String(realm_id ?? id),
      //     new Date(),
      //     String(postID),
      //     String(realm_id ?? id),
      //     Number(ranking_score),
      //   ];

      //   await query(cassandra_feed_query, cassandra_feed_params, {
      //     prepare: true,
      //   });

      // END: CASSANDRA FEED BUILDER

      // if (decodeToken.content.isShared) {
      //   const reference_post_id = finaluploadedreferences[0].reference;
      //   await pool.query(
      //     `
      //       INSERT INTO newsfeed_engagementlog (
      //           log_id, post_id, user_id, action, reference_id, created_at, updated_at
      //       ) VALUES (
      //           gen_random_uuid(), $1, $2, 'shared', $3, NOW(), NOW()
      //       )
      //     `,
      //     [postID, id, reference_post_id],
      //   );
      // }

      await client.query("COMMIT");

      const fanoutCandidates = await GetRankedUsersInConnections(id);

      bulkFanoutToCache(
        fanoutCandidates,
        { id: postID, author_id: id },
        "fanout",
      );

      if (decodeToken.content.isShared) {
        // CASSANDRA LOG INSERT

        const pending_log_id = cassandra.types.uuid();

        const cassandra_log_query =
          "INSERT INTO chatterloop.user_engagement_log " +
          "(log_id, user_id, activity_time, time_spent, activity_type, target_type, target_id, metadata, created_at, updated_at) " +
          "VALUES (?, ?, toTimestamp(now()), ?, ?, ?, ?, ?, toTimestamp(now()), toTimestamp(now()))";

        const cassandra_log_params = [
          pending_log_id,
          id,
          0,
          "share",
          "post",
          postID,
          null,
        ];

        await query(cassandra_log_query, cassandra_log_params, {
          prepare: true,
        });

        // END: CASSANDRA LOG INSERT
      }

      // Notify tagged users if any
      if (decodeToken.tagging.isTagged) {
        const taggedUsernames = decodeToken.tagging.users;

        // Query user IDs for all tagged usernames
        const userQuery = `
          SELECT id
          FROM user_account
          WHERE username = ANY($1)
        `;

        const { rows: userRows } = await client.query(userQuery, [
          taggedUsernames,
        ]);
        notifyTaggedUser(
          userID,
          username,
          postID,
          userRows.map((mp) => mp.id),
        );
      }

      res.send({ status: true, result: "OK" });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Transaction error:", err);
      res
        .status(500)
        .send({ status: false, message: err.message || err.toString() });
    } finally {
      // client.release(); // very important!
      pool.releaseClient(client);
    }
  } catch (ex) {
    console.error(ex);
    res.status(400).send({
      status: false,
      message: "Error processing request",
      details: ex.message,
    });
  }
});

router.get("/feed", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const profileUserID = req.params.profileUserID;
  const page = req.headers["page"];
  const range = req.headers["range"];
  const totalposts = await GetAllPostsCountInProfile(profileUserID);
  const contactslist = await GetListOfContacts(userID);

  // console.log(contactslist);

  await Posts.aggregate([
    //find({ userID: profileUserID }).sort({ _id: -1 }).limit(range)
    {
      $match: {
        $and: [
          {
            $or: [
              { userID: { $in: contactslist } },
              { "tagging.users": { $in: contactslist } },
              { "privacy.status": "public" },
            ],
          },
          {
            userID: { $ne: userID },
          },
        ],
      },
    },
    {
      $lookup: {
        from: "useraccount",
        localField: "tagging.users",
        foreignField: "userID",
        as: "tagged_users",
      },
    },
    {
      $lookup: {
        from: "useraccount",
        let: { userIDPass: "$userID" },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ["$userID", "$$userIDPass"] },
            },
          },
        ],
        as: "post_owner",
      },
    },
    {
      $unwind: "$post_owner",
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
    {
      $project: {
        "tagged_users.dateCreated": 0,
        "tagged_users.email": 0,
        "tagged_users.password": 0,
        "post_owner.dateCreated": 0,
        "post_owner.email": 0,
        "post_owner.password": 0,
      },
    },
  ])
    .then((result) => {
      var posts = result;
      // console.log(result)
      // const encodedResult = createJWT({
      //   posts: posts,
      //   total: totalposts,
      // });

      res.send({
        status: true,
        result: {
          posts: posts,
          total: totalposts,
        },
      });
    })
    .catch((err) => {
      res.send({ status: false, message: err.message });
      console.log(err);
    });
});

module.exports = router;
