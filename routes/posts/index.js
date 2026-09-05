require("dotenv").config();
const express = require("express");
const jwt = require("jsonwebtoken");
const cassandra = require("cassandra-driver");
const multiparty = require("multiparty");
const fs = require("fs/promises");
const sse = require("sse-express");
const {
  sseNotificationsWaiters,
  SendTagPostNotification,
  postActivityChannel,
  BroadcastCommentTyping,
} = require("../../reusables/hooks/sse");
const dateGetter = require("../../reusables/hooks/getDate");
const timeGetter = require("../../reusables/hooks/getTime");
const makeID = require("../../reusables/hooks/makeID");
const { savePostHashtags } = require("../../reusables/hooks/hashtags");
const {
  jwtchecker,
  jwtssechecker,
  createJWT,
} = require("../../reusables/hooks/jwthelper");
const {
  requiresPermission,
} = require("../../reusables/hooks/permissionChecker");
const router = express.Router();

const Posts = require("../../schema/posts/posts");
const UserNotifications = require("../../schema/users/notifications");
const {
  checkPostIDExisting,
  GetAllPostsCountInProfile,
  updateRankingScore,
  createPostScore,
  queueContentTagging,
  ResolvePostPrivacyStatus,
  CanEntityViewPost,
} = require("../../reusables/models/posts");
const { checkNotifID } = require("../../reusables/models/notifications");
const {
  uploadFirebaseMultiple,
  saveFileRecordToDatabase,
} = require("../../reusables/hooks/firebaseupload");
const {
  GetListOfContacts,
  GetSenderDetails,
} = require("../../reusables/models/users");
const push = require("../../reusables/hooks/pushnotification");
const {
  SEND_TAG_POST_NOTIFICATION,
} = require("../../reusables/vars/rabbitmqevents");
const producer = require("../../reusables/rabbitmq/producer");
const {
  publish,
  listen,
  stop_listen,
} = require("../../reusables/redis/pubsub");
const pool = require("../../reusables/database/postgres");
const { generateUUID } = require("../../reusables/hooks/transformers");

const Storage = require("../../reusables/hooks/storage");
const { MAX_UPLOAD_FILE_SIZE } = require("../../reusables/vars/uploads");
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

const notifyTaggedUser = async (entityID, username, postID, tagged_users) => {
  // entityID is the ACTING entity - the realm's entity when posting as a page
  // - whereas `username` comes from req.params.username, which jwtchecker
  // fills from the USER token and so always names the human behind the page.
  // Using it directly made a page tag people under its owner's handle.
  //
  // GetSenderDetails resolves whichever the entity actually is, returning the
  // username for a user and the slug for a realm. `username` stays only as a
  // fallback for an entity that resolves to neither.
  const senderDetails = await GetSenderDetails(entityID);
  const handle = senderDetails?.handle || username;

  // Built once and reused for the stored notification, the SSE broadcast and
  // the push, so the three can't disagree about who did the tagging.
  const details = `@${handle} tagged you on a post.`;

  tagged_users.map(async (mp) => {
    const awaitNotifID = await checkNotifID(`NTF_${makeID(20)}`);
    const notifParams = {
      notificationID: awaitNotifID,
      referenceID: postID,
      // Client-facing destination. Same id as referenceID here, but stated
      // explicitly rather than left to be inferred - the two fields mean
      // different things (backend id vs where the row goes) and only coincide
      // for the post types this service writes.
      target: { type: "post", supportingID: postID, anchor: null },
      referenceStatus: false,
      toUserID: mp,
      fromUserID: entityID,
      content: {
        headline: `You were tagged`,
        details,
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
        SendTagPostNotification(details, mp);
      })
      .catch((err) => {
        console.log(err);
      });
  });

  // One push for the whole tagged set rather than one per person: the tagger
  // and the post are the same for everyone, so the content is identical, and
  // offlineTokensFor resolves every recipient's devices in a single query.
  //
  // Sent alongside the SSE fan-out above, not instead of it - push only
  // reaches devices with no live SSE connection, so the two never overlap.
  push.sendActivity({
    receivers: tagged_users,
    type: "tag_notification",
    // Same headline/details the UserNotifications row carries, so the push
    // and the in-app notification list can't drift apart.
    title: "You were tagged",
    body: details,
    // A tag is about who tagged you, so the thumbnail is their avatar. The
    // post's own image would arguably suit better, but only postID is in
    // scope here and fetching it would cost an extra query on this path.
    senderAvatarUrl: senderDetails?.profile || "",
    // No route: mobile has no post screen yet, so this falls back to the
    // notifications list - which is where the tag is actionable anyway.
  });
};

router.post("/upload", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const id = req.params.id;

  const isMultipart = (req.headers["content-type"] || "").includes(
    "multipart/form-data",
  );

  if (isMultipart) {
    // New multipart path: used by post media, diary attachments (arbitrary
    // file types are intentionally allowed here since diary attachments
    // aren't restricted to image/video the way post media is client-side -
    // enforcement of that narrower rule stays client-side, as it was before).
    new multiparty.Form({ maxFilesSize: MAX_UPLOAD_FILE_SIZE }).parse(
      req,
      async (err, fields, files) => {
        if (err) {
          const isSizeErr = /maxFilesSize/i.test(err.message || "");
          res.status(isSizeErr ? 413 : 400).send({
            status: false,
            message: isSizeErr
              ? "File exceeds the maximum allowed size"
              : "Error processing upload",
            details: err.message,
          });
          return;
        }

        const mediaFiles = files.media || [];

        if (mediaFiles.length === 0) {
          res.status(400).send({ status: false, message: "No files provided" });
          return;
        }

        try {
          const captions = fields.captions
            ? JSON.parse(fields.captions[0])
            : [];
          // Plain scalar, NOT JSON - unlike captions/referenceMediaTypes above,
          // which are real arrays with one entry per file. The [0] is just
          // multiparty handing every field back as an array, so JSON.parse-ing
          // it threw a SyntaxError on any honest value ("post") and 400'd the
          // whole upload. Absent means an older client: keep defaulting.
          const action = fields.action?.[0] || "upload";
          const referenceMediaTypes = fields.referenceMediaTypes
            ? JSON.parse(fields.referenceMediaTypes[0])
            : [];

          const finaluploadedreferences = await Promise.all(
            mediaFiles.map(async (file, i) => {
              const buffer = await fs.readFile(file.path);
              const attachment_id = `NTR_ATTCH_${makeID(20)}`;
              const metadata = await Storage.upload(
                id,
                buffer,
                `${makeID(10)}_${file.originalFilename}`,
                {
                  referenceIDs: [id, attachment_id],
                  action: action,
                },
                `uploads/entries/${id}`,
              );

              return metadata;
            }),
          );

          await Promise.all(
            mediaFiles.map((file) => fs.unlink(file.path).catch(() => {})),
          );

          // file_id: mp.fileID,
          // file_type: mp.fileType,
          // file_name: mp.fileName,
          // url: mp.fileDetails?.data ?? '',

          res.send({ status: true, result: finaluploadedreferences });
        } catch (ex) {
          console.error(ex);
          res.status(400).send({
            status: false,
            message: "Error processing request",
            details: ex.message,
          });
        }
      },
    );
    return;
  }

  // Legacy base64-JSON path - kept alive during rollout so older frontend
  // builds keep working; remove once all callers are confirmed on multipart.
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

    const finaluploadedreferences = await Storage.uploadMultipleBase64(
      filereferences,
      {
        referenceIDs: [id],
        action: body.action ?? "upload",
      },
      `uploads/entries/${id}`,
    );

    res.send({ status: true, result: finaluploadedreferences });
  } catch (ex) {
    console.error(ex);
    res.status(400).send({
      status: false,
      message: "Error processing request",
      details: ex.message,
    });
  }
});

router.post(
  "/createpost",
  jwtchecker,
  requiresPermission("posts.create"),
  async (req, res) => {
    const userID = req.params.userID;
    const username = req.params.username;
    const id = req.params.id;
    const entityID = req.params.entity_id;
    const postID = await checkPostIDExisting(makeID(30));
    const currentTimestampInSeconds = Math.floor(Date.now() / 1000);

    const token = req.body.token;

    try {
      const decodeToken = jwt.verify(token, JWT_SECRET);
      const filereferencesraw = decodeToken.content.references;
      const content_type = decodeToken.type.contentType;
      const otherEntityID = decodeToken.otherEntityID;
      const filereferences = filereferencesraw.map((mp) => ({
        name: mp.name || `${postID}_${makeID(20)}`,
        caption: mp.caption,
        reference: mp.reference,
        referenceMediaType: mp.referenceMediaType,
        referenceID: `${postID}_${makeID(20)}`,
      }));

      // References may already be CDN URLs if the client uploaded media
      // up-front via POST /posts/upload (the new two-step flow) - in that case
      // there's nothing left to upload here. Legacy clients that still embed
      // base64 media directly in the signed payload fall through to the
      // original inline-upload path for backward compatibility.
      const isAlreadyUploaded = (ref) =>
        typeof ref === "string" && /^https?:\/\//i.test(ref);

      const finaluploadedreferences =
        decodeToken.content.isShared ||
        filereferences.every((mp) => isAlreadyUploaded(mp.reference))
          ? filereferences
          : await Storage.uploadMultipleBase64(
              filereferences,
              {
                referenceIDs: [postID],
                action: "post",
              },
              `uploads/posts/${id}/${postID}`,
            );

      if (decodeToken.content.isShared) {
        finaluploadedreferences.forEach(async (mp) => {
          const { rows: query_post_user } = await pool.query(
            `SELECT 
                ua.username,
                ua.id,
                ua.entity_id AS "entityID" 
            FROM 
                newsfeed_post np 
            JOIN 
                user_account ua  
            ON 
                np.entity_id  = ua.entity_id 
            WHERE
                np.post_id = $1
          `,
            [mp.reference],
          );

          if (query_post_user.length > 0) {
            const post_user = query_post_user[0].entityID;

            if (post_user !== entityID) {
              interactionScoreBump(entityID, post_user, "SHARE", false);
              followerInteractionScoreBump(
                entityID,
                otherEntityID,
                "SHARE",
                false,
              );

              const awaitNotifID = await checkNotifID(`NTF_${makeID(20)}`);
              // entityID is the ACTING entity; `username` is always the human
              // behind it (jwtchecker sets it from the user row), so sharing as
              // a page credited the owner instead of the page.
              const sharerDetails = await GetSenderDetails(entityID);
              const shareDetails = `@${sharerDetails?.handle || username} shared your post.`;

              const notifParams = {
                notificationID: awaitNotifID,
                referenceID: postID,
                // See the tag notification above - stated rather than inferred.
                target: { type: "post", supportingID: postID, anchor: null },
                referenceStatus: false,
                toUserID: post_user,
                fromUserID: entityID,
                content: {
                  headline: `Shared post`,
                  details: shareDetails,
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
                    message: shareDetails,
                    result: "", //encodedResult
                  });
                })
                .catch((err) => {
                  console.log(err);
                });
            }

            // shares_count is NOT incremented here any more: the worker's
            // UpdateRankingScore moves the counter itself as part of
            // recomputing the score, so doing both counts every share twice.
            updateRankingScore(mp.reference, "share", false);
          }

          // saveFileRecordToDatabase(
          //   [mp.referenceID],
          //   mp.reference,
          //   "post",
          //   mp.referenceMediaType,
          //   "digitalocean",
          //   mp.name,
          // );
        });
      }

      // A private profile's posts default to connections-only. Resolved here,
      // against user_account.is_private, rather than taken from the signed
      // payload as-is - see ResolvePostPrivacyStatus for why an explicit choice
      // still wins but a missing one must not default to public.
      const resolvedPrivacyStatus = await ResolvePostPrivacyStatus(
        entityID,
        decodeToken.privacy?.status,
      );

      // Prepare main post insert
      const postInsertQuery = `
      INSERT INTO newsfeed_post (
        post_id, entity_id, is_sponsored, is_live, on_feed, from_system, date_posted,
        is_shared, file_type, caption, content_type, is_tagged, privacy_status, is_archived
      ) VALUES (
        $1, $2, $3, $4, $5, $6, to_timestamp($7),
        $8, $9, $10, $11, $12, $13, $14
      );
    `;
      const postValues = [
        postID,
        entityID,
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
        resolvedPrivacyStatus,
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
            await pool.query(
              `WITH target_record AS (
                SELECT type FROM entity_entity WHERE id = $1
              )
              , run_realm_update AS (
                UPDATE community_realm
                SET profile = $2
                WHERE entity_id = $1 AND (SELECT type FROM target_record) = 'realm'
              )
              UPDATE user_account
              SET profile = $2
              WHERE entity_id = $1 AND (SELECT type FROM target_record) = 'user'
              RETURNING id;
            `,
              [entityID, finaluploadedreferences[0].reference],
            );
          }

          if (content_type === "cover_photo") {
            await pool.query(
              `WITH target_record AS (
                SELECT type FROM entity_entity WHERE id = $1
              )
              , run_realm_update AS (
                UPDATE community_realm
                SET cover_photo = $2
                WHERE entity_id = $1 AND (SELECT type FROM target_record) = 'realm'
              )
              UPDATE user_account
              SET coverphoto = $2
              WHERE entity_id = $1 AND (SELECT type FROM target_record) = 'user'
              RETURNING id;
            `,
              [entityID, finaluploadedreferences[0].reference],
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
          // tagging.users holds entity ids - a user OR a realm/page (newsfeed_
          // posttag.entity_id FKs the generic entity table, so both are valid).
          // Validate against entity_entity so a stale/bogus id can't FK-violate
          // and roll the whole post back, and so we insert each tag exactly once.
          const taggedEntityIds = decodeToken.tagging.users;

          const { rows: entityRows } = await client.query(
            `SELECT id FROM entity_entity WHERE id = ANY($1)`,
            [taggedEntityIds],
          );

          if (entityRows.length > 0) {
            const tagValues = [];
            const tagRowsSQL = entityRows
              .map((entity, i) => {
                const postTagId = generateUUID();
                tagValues.push(postTagId, postID, entity.id);
                const baseIndex = i * 3;
                return `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3})`;
              })
              .join(", ");

            const insertTagQuery = `
            INSERT INTO newsfeed_posttag (post_tag_id, post_id, entity_id)
            VALUES ${tagRowsSQL};
          `;

            await client.query(insertTagQuery, tagValues);
          }
        }

        // newsfeed_previewcount rows are NOT seeded here any more. This used to
        // write one count=0 row per emoji for every new post, which made that
        // table posts x emojis - almost entirely zeros - and grew the cost of
        // creating a post with every emoji ever added.
        //
        // A missing row and a count=0 row are the same thing to every reader:
        // the clients render preview.filter(count > 0), the totals sum
        // identically, and the emoji picker reads newsfeed_emoji rather than
        // this table. The Django reaction endpoints (user_service
        // newsfeed/views.py PostReactionsView) create the row on first reaction
        // via get_or_create, guarded by a unique constraint on
        // (post_id, emoji_id) so two simultaneous first-reactions can't split
        // the count. Nothing else in this service touches newsfeed_previewcount.
        //
        // newsfeed_postscore below is deliberately NOT lazy: an absent score row
        // means ranking_score 0.0, which would bury a brand-new post at the
        // bottom of every ranked feed with no way to recover - nobody sees it,
        // so nobody interacts, so nothing ever creates the row.

        // Hashtags in the caption become interests, linked to this post.
        //
        // Inside the transaction, unlike the moderation publish below: these
        // are rows about the post, so they belong to the same commit and must
        // vanish with it if it rolls back. Cheap enough to sit here - a regex
        // and one upsert per distinct tag, no network call and no model.
        //
        // Links only. All SCORING (affinity, trending) stays with the
        // moderation service's interest sink, which is its single writer and
        // reaches this post either by the queue publish below or by its own
        // scour - exactly once either way.
        await savePostHashtags(client, postID, decodeToken.content.data);

        // POST SCORE TABLE SAVE
        //
        // Published AFTER the commit below rather than inserted here: the
        // handler reads newsfeed_postreference to weight the post by its media,
        // and those rows are written in this same transaction - publishing
        // before the commit scores the post as if it had no attachments.
        //
        // Note the scoring constants are now the worker's, which are the Django
        // signal's (+1.2 image / +1.5 video, decay ^1.2, no base engagement) and
        // NOT the ones this block used. Post scores will differ from before.

        // END: POST SCORE TABLE SAVE

        await client.query("COMMIT");

        createPostScore(postID, new Date(currentTimestampInSeconds * 1000));

        // Fan out to the author's FOLLOWERS, not their connections. The feed is
        // keyed on the follow graph now; connecting auto-follows both ways, so
        // connections still receive this via the follow it created. Also fixes
        // pages: the connection-based query JOINed user_account on both sides,
        // so a page's post previously fanned out to nobody.
        // The follower query moved into the worker, which resolves it from
        // current_entity_id - same filter, same ORDER BY, same 500 cap - so
        // GetFollowerIDs is no longer called on this path.
        bulkFanoutToCache(
          entityID,
          { id: postID, author_id: entityID },
          "fanout",
        );

        // Moderation and interest tagging. Skips silently when the moderation
        // service is offline - its scour picks the post up later - so a post
        // never waits on it and never fails because of it. Not awaited: the
        // response should not carry the latency of a queue publish.
        queueContentTagging({
          postID,
          entityID,
          caption: decodeToken.content.data,
          references: finaluploadedreferences,
        });

        if (decodeToken.content.isShared) {
          // CASSANDRA LOG INSERT

          const pending_log_id = cassandra.types.uuid();

          const cassandra_log_query =
            "INSERT INTO chatterloop.user_engagement_log " +
            "(log_id, user_id, activity_time, time_spent, activity_type, target_type, target_id, metadata, created_at, updated_at) " +
            "VALUES (?, ?, toTimestamp(now()), ?, ?, ?, ?, ?, toTimestamp(now()), toTimestamp(now()))";

          const cassandra_log_params = [
            pending_log_id,
            entityID,
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
          SELECT entity_id AS "entityID"
          FROM user_account
          WHERE entity_id = ANY($1)
        `;

          const { rows: userRows } = await client.query(userQuery, [
            taggedUsernames,
          ]);
          notifyTaggedUser(
            entityID,
            username,
            postID,
            userRows.map((mp) => mp.entityID),
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
  },
);

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

// --- Post activity stream --------------------------------------------------

/**
 * Live activity on ONE post: comments as they are written, and who is typing.
 *
 * Built exactly like /u/sseNotifications - sse-express + jwtssechecker, a
 * Redis channel bridged to the response by listen()/stop_listen() - and
 * differs in the one thing that matters: it is scoped to a POST rather than to
 * the viewer's entity. The token is the same envelope with a `post_id` signed
 * into it (jwthelper.js reads it back out).
 *
 * WHY A SECOND STREAM AND NOT ANOTHER EVENT ON THE FIRST. The notification
 * stream fans out per recipient, so a comment would have to be published once
 * per person reading the post - and nothing knows who those people are. A post
 * channel has exactly one publish and however many readers happen to be there.
 *
 * WHO OPENS IT. Only the surfaces that show a post in full - the post modal
 * and /post/:id. A feed renders many post cards at once and opening one of
 * these per card would mean dozens of live connections for a single scroll,
 * which is the reason this is not simply always-on inside the comment section.
 *
 * Carries NO session side effects, unlike the notification stream: that one
 * flips the user's online status and tells their contacts, and doing that here
 * would make opening a post look like signing in - and closing one, like
 * signing out, while the notification stream is still open.
 */
router.get(
  "/ssePostActivity/:token",
  [sse, jwtssechecker],
  async (req, res) => {
    const entity_id = req.params.entity_id;
    const postID = req.params.post_id;

    if (!postID) {
      res.sse("post_activity", {
        status: false,
        auth: true,
        message: "No post to watch",
      });
      return;
    }

    // Subscribing is scoped by post id, so this is the only thing standing
    // between a known id and a restricted post's comment traffic.
    const allowed = await CanEntityViewPost(postID, entity_id);

    if (!allowed) {
      res.sse("post_activity", {
        status: false,
        auth: true,
        message: "Post not available",
      });
      return;
    }

    const redis_event = postActivityChannel(postID);

    listen(redis_event, res);

    req.on("close", () => {
      stop_listen(redis_event, res);
    });
  },
);

/**
 * "I am typing a comment on this post."
 *
 * The comment-section twin of /m/istypingbroadcast, and the same shape of
 * thing: a POST that publishes and stores nothing. It differs in who it
 * reaches - the messenger names its recipients from the conversation's member
 * list and publishes to each of them, whereas here the audience is whoever
 * happens to have the post open, which only the post's own channel can
 * address.
 *
 * Gated on being able to SEE the post, so this cannot be used to announce
 * yourself into a discussion you have no access to.
 *
 * `parent_id` is optional and says which box is being typed in - absent for
 * the post's main comment box, a top-level comment's id for that comment's
 * reply box - so the indicator can appear where the reply will actually land.
 *
 * The client throttles re-broadcasts (one every 5s while typing) and receivers
 * expire the indicator on their own after a few seconds - there is deliberately
 * no "stopped typing" event to miss.
 */
router.post("/commenttypingbroadcast", jwtchecker, async (req, res) => {
  const entity_id = req.params.entity_id;
  const postID = req.body.post_id;
  const parentID = req.body.parent_id;

  try {
    if (!postID) {
      throw new Error("No post to broadcast to");
    }

    const allowed = await CanEntityViewPost(postID, entity_id);

    if (!allowed) {
      return res
        .status(404)
        .send({ status: false, message: "Post not available" });
    }

    // Names the typer rather than saying "someone" - the indicator shows a
    // handle, and a page typing as itself should read as the page.
    const typer = await GetSenderDetails(entity_id);

    BroadcastCommentTyping(postID, entity_id, typer, parentID);

    res.send({ status: true, message: "OK" });
  } catch (ex) {
    console.log(ex);
    res
      .status(400)
      .send({ status: false, message: ex.message || ex.toString() });
  }
});

module.exports = router;
