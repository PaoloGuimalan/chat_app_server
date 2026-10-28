const { createHash, randomUUID } = require("node:crypto");

const INBOX = "community_admin_inbox";
const PREVIEW = "community_admin_activity";
const CREATED = "community_post_created";
const COMMUNITY_ACTIVITY_TYPES = [
  "community_join_request",
  "community_member_joined",
  CREATED,
  "post_comment",
  "post_reaction",
  "comment_reaction",
];
const URL_NAMESPACE = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");

// Match Django's _notice_id so both services acknowledge the same inbox rows.
function noticeID(reference, recipient, kind) {
  const bytes = createHash("sha1")
    .update(URL_NAMESPACE)
    .update(kind + ":" + reference + ":" + recipient)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex");
  return "NTF_community_admin_" + [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

const slotID = (community, admin) =>
  createHash("sha256")
    .update(JSON.stringify(["community_admin_preview", community, admin]))
    .digest("hex")
    .slice(0, 24);

const redirects = (realm) => ["web", "android", "ios"].map((platform) => ({
  platform,
  type: "community_notifications",
  route: platform === "web"
    ? "/realms/" + realm + "/notifications"
    : "/realm/" + realm + "/manage/notifications",
}));

function createCommunityPostNotifier({
  notifications,
  client,
  canManage,
  publish,
  now = () => new Date().toISOString(),
}) {
  async function savePreview(post, admin) {
    if (!(await canManage(admin, post.community_entity_id))) return;
    const id = slotID(post.community_entity_id, admin);
    let notificationID;
    let unread;
    while (true) {
      const previous = await notifications.findOne({ _id: id });
      const previousID = previous?.notificationID;
      const timestamp = now();
      const canonicalIDs = await notifications.distinct("notificationID", {
        toUserID: post.community_entity_id,
        type: { $in: COMMUNITY_ACTIVITY_TYPES },
      });
      unread = {
        referenceID: { $in: canonicalIDs },
        type: INBOX,
        toUserID: admin,
        isRead: false,
        "date.date": { $lte: timestamp },
      };
      const count = await notifications.countDocuments(unread);
      if (!count) return;
      notificationID = "NTF_community_preview_" + randomUUID();
      const noun = count === 1 ? "activity" : "activities";
      const fields = {
        notificationID,
        referenceID: post.community_entity_id,
        referenceStatus: true,
        toUserID: admin,
        fromUserID: post.community_entity_id,
        is_anonymous: false,
        type: PREVIEW,
        isRead: false,
        content: {
          headline: "Community activity preview",
          details: `${count} new ${noun} in your community. Check them out.`,
        },
        date: { date: timestamp },
        target: { type: "community_notifications", supportingID: post.realm_id },
        redirects: redirects(post.realm_id),
      };
      const match = {
        _id: id,
        notificationID: previousID ?? { $exists: false },
      };
      try {
        const result = await notifications.updateOne(
          match,
          { $set: fields },
          { upsert: !previous },
        );
        if (previous && !result.matchedCount) continue;
        break;
      } catch (error) {
        if (error.code !== 11000) throw error;
        // Another writer replaced the slot. Recount before trying its new revision.
      }
    }
    await notifications.deleteMany({
      type: PREVIEW,
      toUserID: admin,
      fromUserID: post.community_entity_id,
      _id: { $ne: id },
    });
    if (!(await notifications.countDocuments(unread))) {
      await notifications.updateOne({ notificationID }, { $set: { isRead: true } });
    }
    const current = await notifications.findOne({ notificationID });
    if (!current) return;
    const payload = {
      status: true,
      auth: true,
      message: "Community notifications changed",
      result: {
        type: PREVIEW,
        realm_id: post.realm_id,
        fromUserID: post.community_entity_id,
      },
    };
    await publish(
      "events_" + admin,
      current.isRead ? "notifications_reload" : "notifications",
      payload,
    );
    await publish("events_" + admin, "community_admin_preview_changed", payload);
  }

  return async function notify(postID) {
    const { rows: posts } = await client.query(
      `SELECT p.post_id, p.entity_id AS author_id, p.is_anonymous, r.id AS realm_id,
              r.entity_id AS community_entity_id, r.name AS community_name,
              COALESCE(u.username, author.slug, b.handle) AS handle
       FROM newsfeed_post p
       JOIN newsfeed_posttag t ON t.post_id = p.post_id
       JOIN community_realm r ON r.entity_id = t.entity_id AND r.type = 'community'
       LEFT JOIN user_account u ON u.entity_id = p.entity_id
       LEFT JOIN community_realm author ON author.entity_id = p.entity_id
       LEFT JOIN bot_bot b ON b.entity_id = p.entity_id
       WHERE p.post_id = $1 AND r.is_active = TRUE
         AND p.deleted_at IS NULL AND p.is_archived = FALSE`,
      [postID],
    );
    const post = posts[0];
    if (!post) return;
    const { rows: managers } = await client.query(
      `SELECT entity_id FROM community_member WHERE realm_id = $1
       AND role IN ('owner', 'admin', 'moderator')`,
      [post.realm_id],
    );
    const canonicalID = noticeID(postID, post.community_entity_id, CREATED);
    const subject = post.is_anonymous
      ? "An anonymous member"
      : post.handle ? "@" + post.handle : "A member";
    const fields = {
      referenceID: postID,
      referenceStatus: true,
      type: CREATED,
      fromUserID: post.is_anonymous ? post.community_entity_id : post.author_id,
      is_anonymous: Boolean(post.is_anonymous),
      content: {
        headline: "New community post",
        details: `${subject} posted in ${post.community_name}.`,
      },
      date: { date: now() },
      target: { type: "post", supportingID: postID, anchor: null },
      isRead: false,
    };
    const inserted = [];
    for (const admin of new Set(managers.map((row) => String(row.entity_id)))) {
      if (admin === String(post.author_id)) continue;
      const id = noticeID(canonicalID, admin, INBOX);
      const result = await notifications.updateOne(
        { notificationID: id },
        {
          $setOnInsert: {
            ...fields,
            notificationID: id,
            referenceID: canonicalID,
            type: INBOX,
            toUserID: admin,
          },
        },
        { upsert: true },
      );
      if (result.upsertedCount) inserted.push(admin);
    }
    await notifications.updateOne(
      { notificationID: canonicalID },
      {
        $setOnInsert: {
          ...fields,
          notificationID: canonicalID,
          toUserID: post.community_entity_id,
        },
      },
      { upsert: true },
    );
    for (const admin of inserted) {
      await publish("events_" + admin, "community_notifications_changed", {
        status: true,
        auth: true,
        message: "New community post",
        result: {
          realm_id: post.realm_id,
          },
      });
      await savePreview(post, admin);
    }
  };
}

async function notifyCommunityPostCreated({ postID }) {
  try {
    const client = require("../database/postgres");
    const { publish } = require("../redis/pubsub");
    const { canManageCommunityNotifications } = require("./communityNotifications");
    await createCommunityPostNotifier({
      notifications: require("../../schema/users/notifications"),
      client,
      publish,
      canManage: (admin, community) =>
        canManageCommunityNotifications(client, admin, community),
    })(postID);
  } catch (error) {
    // A notification failure cannot undo a post that already committed.
    console.error("[community notifications] Could not record post activity:", error.message);
  }
}

module.exports = { createCommunityPostNotifier, notifyCommunityPostCreated, noticeID };
