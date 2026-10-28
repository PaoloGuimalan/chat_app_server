const { createHash } = require("crypto");
const pool = require("../database/postgres");
const UserNotifications = require("../../schema/users/notifications");
const { publish } = require("../redis/pubsub");
const push = require("../hooks/pushnotification");
const dateGetter = require("../hooks/getDate");
const timeGetter = require("../hooks/getTime");

// Called only after the photo/post transaction commits. Resolve the current
// audience from membership, including for a public community, and let the push
// worker recheck it again at delivery using communityPostID.
const notifyCommunityMediaUpdate = async ({ community, postID, mediaType }) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT m.entity_id
     FROM community_realm r
     JOIN community_member m ON m.realm_id = r.id
     JOIN newsfeed_post p ON p.post_id = $3 AND p.entity_id = r.entity_id
     WHERE r.realm_id = $1 AND r.entity_id = $2 AND r.type = 'community'
       AND r.is_active = TRUE AND p.deleted_at IS NULL AND p.is_archived = FALSE
       AND p.from_system = TRUE AND p.details->>'community_media_update' = 'true'
       AND EXISTS (SELECT 1 FROM newsfeed_posttag t
                   WHERE t.post_id = p.post_id AND t.entity_id = r.entity_id)`,
    [community.realm_id, community.entity_id, postID],
  );
  const title = "Community activity";
  const details = mediaType === "cover_photo"
    ? "The community updated its cover photo."
    : "The community updated its profile photo.";
  const metadata = {
    post_id: postID,
    community_entity_id: community.entity_id,
    is_anonymous: false,
  };
  const notified = [];
  for (const memberID of new Set(rows.map((row) => String(row.entity_id)))) {
    const deliveryHash = createHash("sha256")
      .update(JSON.stringify([postID, memberID])).digest("hex");
    const notificationID = `NTF_${deliveryHash}`;
    await UserNotifications.updateOne(
      // Mongo already uniquely indexes _id. A deterministic ObjectId prevents
      // concurrent upload retries from inserting two notice documents without
      // requiring a new index/migration for notificationID.
      { _id: deliveryHash.slice(0, 24), notificationID },
      { $setOnInsert: {
        notificationID,
        referenceID: postID,
        referenceStatus: false,
        target: { type: "post", supportingID: postID, anchor: null },
        toUserID: memberID,
        fromUserID: community.entity_id,
        is_anonymous: false,
        content: { headline: title, details },
        date: { date: dateGetter(), time: timeGetter() },
        type: "community_activity",
        isRead: false,
      } },
      { upsert: true },
    );
    // A stored row proves persistence, not SSE/push delivery. Replays repair
    // failures after an upsert using the same notice ID and push collapse tag.
    notified.push(memberID);
    await publish(`events_${memberID}`, "notifications", {
      status: true, auth: true, message: details,
      result: { ...metadata, notification_id: notificationID },
    }, { required: true });
  }
  if (notified.length) {
    const accepted = await push.send({
      entityIDs: notified,
      title,
      body: "New activity in your community.",
      communityPostID: postID,
      tag: `community-${postID}`,
      required: true,
      data: {
        type: "community_activity",
        route: `/post/${postID}`,
        notification_id: `community-media-${postID}`,
        ...metadata,
      },
    });
    if (!accepted) throw new Error("Community push was not accepted");
  }
};

module.exports = { notifyCommunityMediaUpdate };
