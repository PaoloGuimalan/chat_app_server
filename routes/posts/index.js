require("dotenv").config();
const express = require("express");
const jwt = require("jsonwebtoken");
const {
  sseNotificationsWaiters,
  SendTagPostNotification,
} = require("../../reusables/hooks/sse");
const dateGetter = require("../../reusables/hooks/getDate");
const timeGetter = require("../../reusables/hooks/getTime");
const makeID = require("../../reusables/hooks/makeID");
const { jwtchecker, createJWT } = require("../../reusables/hooks/jwthelper");
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
const { GetListOfContacts } = require("../../reusables/models/users");
const {
  SEND_TAG_POST_NOTIFICATION,
} = require("../../reusables/vars/rabbitmqevents");
const producer = require("../../reusables/rabbitmq/producer");
const { publish } = require("../../reusables/redis/pubsub");
const pool = require("../../reusables/database/postgres");
const { generateUUID } = require("../../reusables/hooks/transformers");

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

const notifyTaggedUser = async (userID, postID, tagged_users) => {
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
        details: `@${userID} tagged you on a post.`,
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
        // publish(`events_${mp}`, SEND_TAG_POST_NOTIFICATION, {
        //   parameters: {
        //     details: `@${userID} tagged you on a post.`,
        //     userID: mp,
        //   },
        // });
        // await producer.publishMessage("INFO:CHATTERLOOP", SEND_TAG_POST_NOTIFICATION, {
        //     parameters: {
        //         details: `@${userID} tagged you on a post.`,
        //         userID: mp,
        //     }
        // });
        // sseNotificationstrigger(type, sendFromUser, actionlog)
      })
      .catch((err) => {
        console.log(err);
      });
  });
};

// router.post("/createpost", jwtchecker, async (req, res) => {
//   const userID = req.params.userID;
//   const postID = await checkPostIDExisting(makeID(30));
//   const currentTimestampInSeconds = Math.floor(Date.now() / 1000);

//   const token = req.body.token;

//   try {
//     const decodeToken = jwt.verify(token, JWT_SECRET);
//     const filereferencesraw = decodeToken.content.references;
//     const filereferences = filereferencesraw.map((mp) => ({
//       name: mp.name,
//       caption: mp.caption,
//       reference: mp.reference,
//       referenceMediaType: mp.referenceMediaType,
//       referenceID: `${postID}_${makeID(20)}`,
//     }));

//     const finaluploadedreferences = decodeToken.content.isShared
//       ? filereferences
//       : await uploadFirebaseMultiple(filereferences);

//     if (decodeToken.content.isShared) {
//       finaluploadedreferences.map((mp) => {
//         saveFileRecordToDatabase(
//           [mp.referenceID],
//           mp.reference,
//           "post",
//           mp.referenceMediaType,
//           "firebase"
//         );
//       });
//     }

//     const payload = {
//       postID: postID,
//       userID: userID,
//       isSponsored: false,
//       isLive: false,
//       isOnMap: {
//         status: false,
//         isStationary: true,
//       },
//       fromSystem: true,
//       dateposted: currentTimestampInSeconds,
//       ...decodeToken,
//       content: {
//         ...decodeToken.content,
//         references: finaluploadedreferences,
//       },
//     };

//     // console.log(userID, payload, payload.content.references);

//     const newPost = new Posts(payload);

//     newPost
//       .save()
//       .then(() => {
//         // use sse to return response with data
//         if (decodeToken.tagging.isTagged) {
//           notifyTaggedUser(userID, postID, decodeToken.tagging.users);
//         }
//         res.send({ status: true, result: "OK" });
//       })
//       .catch((err) => {
//         res.send({ status: false, message: err.message });
//         console.log(err);
//       });
//   } catch (ex) {
//     console.log(ex);
//     res.send({ status: false, message: "Cannot decode token" });
//   }
// });

router.post("/createpost", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const id = req.params.id;
  const postID = await checkPostIDExisting(makeID(30));
  const currentTimestampInSeconds = Math.floor(Date.now() / 1000);

  const token = req.body.token;

  try {
    const decodeToken = jwt.verify(token, JWT_SECRET);
    const filereferencesraw = decodeToken.content.references;
    const content_type = decodeToken.type.contentType;
    const filereferences = filereferencesraw.map((mp) => ({
      name: mp.name,
      caption: mp.caption,
      reference: mp.reference,
      referenceMediaType: mp.referenceMediaType,
      referenceID: `${postID}_${makeID(20)}`,
    }));

    const finaluploadedreferences = decodeToken.content.isShared
      ? filereferences
      : await uploadFirebaseMultiple(filereferences);

    if (decodeToken.content.isShared) {
      finaluploadedreferences.forEach(async (mp) => {
        const { rows: query_post_user } = await pool.query(
          `SELECT 
                ua.username 
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

        await pool.query(
          `
          INSERT INTO newsfeed_engagementlog (
              log_id, post_id, user_id, action, reference_id, created_at
          ) VALUES (
              gen_random_uuid(),
              $1, 
              $2,
              'shared',
              $3, 
              NOW()
          )
      `,
          [postID, id, mp.reference],
        );

        if (query_post_user.length > 0) {
          const post_user = query_post_user[0].username;

          if (post_user !== userID) {
            const awaitNotifID = await checkNotifID(`NTF_${makeID(20)}`);
            const notifParams = {
              notificationID: awaitNotifID,
              referenceID: postID,
              referenceStatus: false,
              toUserID: post_user,
              fromUserID: userID,
              content: {
                headline: `Shared post`,
                details: `@${userID} shared your post.`,
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
                  message: `@${userID} shared your post.`,
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
        );
      });
    }

    // Prepare main post insert
    const postInsertQuery = `
      INSERT INTO newsfeed_post (
        post_id, user_id, is_sponsored, is_live, on_feed, from_system, date_posted,
        is_shared, file_type, caption, content_type, is_tagged, privacy_status
      ) VALUES (
        $1, $2, $3, $4, $5, $6, to_timestamp($7),
        $8, $9, $10, $11, $12, $13
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
    ];

    const client = await pool.getPool();

    try {
      await client.query("BEGIN");

      // Insert Post
      await client.query(postInsertQuery, postValues);

      // Batch insert post references
      if (finaluploadedreferences.length > 0) {
        if (content_type === "profile") {
          await pool.query(
            `UPDATE user_account
            SET profile = $1
            WHERE username = $2
          `,
            [finaluploadedreferences[0].reference, userID],
          );
        }

        if (content_type === "cover_photo") {
          await pool.query(
            `UPDATE user_account
            SET coverphoto = $1
            WHERE username = $2
          `,
            [finaluploadedreferences[0].reference, userID],
          );
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
        SELECT uuid_generate_v4(), $1, emoji_id, 0
        FROM newsfeed_emoji;
      `;

      await client.query(insertPreviewCountsQuery, [postID]);

      // const insertActivityCount = `
      //   INSERT INTO newsfeed_activitycount (count_id, count_type, count, post_id)
      //   VALUES
      //   (uuid_generate_v4(), 'share', 0, $1),
      //   (uuid_generate_v4(), 'comment', 0, $1);
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

      await client.query("COMMIT");

      // Notify tagged users if any
      if (decodeToken.tagging.isTagged) {
        notifyTaggedUser(userID, postID, decodeToken.tagging.users);
      }

      res.send({ status: true, result: "OK" });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Transaction error:", err);
      res.status(500).send({ status: false, message: "Database error." });
    } finally {
      // client.release(); // very important!
      pool.releaseClient(client);
    }
  } catch (ex) {
    console.error(ex);
    res.status(400).send({ status: false, message: "Cannot decode token" });
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
