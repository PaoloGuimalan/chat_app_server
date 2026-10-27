// Community identity is independent of the sender. Both current actor-sender
// rows and legacy community-sender rows are checked before Mongo pagination.
const MANAGEMENT_NOTIFICATION_TYPES = ["community_join_request", "community_admin_activity"];
const isCommunityManagementNotification = (item) => MANAGEMENT_NOTIFICATION_TYPES.includes(item?.type);

const managementPermission = (...args) => require("../hooks/permissionChecker").hasPermission(...args);

const hasManagementPermission = async (viewerID, realmID, checkPermission) => {
  try {
    return Boolean(await checkPermission(viewerID, "realm.request.approve", realmID));
  } catch {
    return false;
  }
};

const notificationReadMatch = (viewerID, summaries = []) => {
  if (!Array.isArray(summaries) || summaries.length > 500) {
    throw new TypeError("Invalid community notification read snapshots");
  }
  const snapshots = summaries.map((item) => {
    if (!item || typeof item.notificationID !== "string" || !item.notificationID ||
        item.notificationID.length > 200 || !Number.isSafeInteger(item.activity_revision) ||
        item.activity_revision < 0) {
      throw new TypeError("Invalid community notification read snapshot");
    }
    return {
      type: "community_admin_activity",
      notificationID: item.notificationID,
      activity_revision: item.activity_revision,
    };
  });
  return {
    toUserID: viewerID,
    isRead: false,
    $or: [{ type: { $ne: "community_admin_activity" } }, ...snapshots],
  };
};

// A coalesced summary keeps its original ObjectId. Rank its latest event,
// otherwise new unread activity would stay buried at its creation position.
const notificationSortStages = (keepTime = false) => {
  const created = { $convert: { input: "$_id", to: "date", onError: null, onNull: null } };
  return [
    { $addFields: { _notificationSort: { $convert: {
      input: { $cond: [{ $eq: ["$type", "community_admin_activity"] }, "$date.date", "$_id"] },
      to: "date", onError: created, onNull: created,
    } } } },
    { $sort: { _notificationSort: -1, _id: -1 } },
    ...(keepTime ? [] : [{ $project: { _notificationSort: 0 } }]),
  ];
};

const notificationAudienceMatch = async (client, match, viewerID, checkPermission = managementPermission) => {
  const { rows } = await client.query(
    `SELECT r.id, r.entity_id,
            (r.is_active = TRUE AND m.entity_id IS NOT NULL) AS member_allowed,
            (r.is_active = TRUE AND COALESCE(m.role IN ('owner', 'admin', 'moderator'), FALSE)) AS management_allowed
     FROM community_realm r
     LEFT JOIN community_member m ON m.realm_id = r.id AND m.entity_id = $1
     WHERE r.type = 'community'`,
    [viewerID],
  );
  const blocked = rows.filter((row) => !row.member_allowed).map((row) => String(row.entity_id));
  const managed = [];
  for (const row of rows) {
    if (row.management_allowed && await hasManagementPermission(viewerID, row.id, checkPermission)) {
      managed.push(String(row.entity_id));
    }
  }
  return {
    $and: [
      match,
      ...(blocked.length ? [
        { fromUserID: { $nin: blocked } },
        { community_entity_id: { $nin: blocked } },
      ] : []),
      { $or: [
        { type: { $nin: MANAGEMENT_NOTIFICATION_TYPES } },
        { community_entity_id: { $in: managed } },
      ] },
    ],
  };
};

const canManageCommunityNotifications = async (client, viewerID, communityID, checkPermission = managementPermission) => {
  if (!viewerID || !communityID) return false;
  const { rows } = await client.query(
    `SELECT r.id, r.entity_id FROM community_realm r
     JOIN community_member m ON m.realm_id = r.id AND m.entity_id = $1
     WHERE r.entity_id = $2 AND r.type = 'community' AND r.is_active = TRUE
       AND m.role IN ('owner', 'admin', 'moderator')
     LIMIT 1`,
    [viewerID, communityID],
  );
  return rows.length > 0 && hasManagementPermission(viewerID, rows[0].id, checkPermission);
};

const authorizedNotificationStream = (response, authorize, authorizeManagement = async () => false) => ({
  async sse(event, payload) {
    const target = payload?.result;
    if (isCommunityManagementNotification(target)) {
      try {
        if (!target.community_entity_id || !(await authorizeManagement(target.community_entity_id))) return;
      } catch {
        return;
      }
    } else if (target?.community_entity_id && target?.post_id) {
      try {
        if (!(await authorize(target.post_id))) return;
      } catch {
        return;
      }
    }
    response.sse(event, payload);
  },
});

const normalizeCommunityNotifications = async (client, items) => {
  for (const item of items) {
    if (item.type !== "community_admin_activity") continue;
    const count = Number.isSafeInteger(item.activity_count) && item.activity_count >= 0
      ? item.activity_count : 0;
    item.content = {
      ...item.content,
      details: `${count} new ${count === 1 ? "activity" : "activities"} in ${item.community_name || "your community"}. Check them out.`,
    };
  }
  const candidates = items.filter(
    (item) => !isCommunityManagementNotification(item) &&
      (item.community_entity_id || item.target?.type === "post"),
  );
  if (!candidates.length) return;
  const postIDs = [...new Set(candidates
    .map((item) => item.target?.supportingID)
    .filter(Boolean)
    .map(String))];
  const { rows: destinations } = await client.query(
    `SELECT p.post_id, r.entity_id AS community_entity_id, r.name AS community_name,
            p.entity_id AS post_author_id, p.from_system, p.details
     FROM newsfeed_post p JOIN newsfeed_posttag t ON t.post_id = p.post_id
     JOIN community_realm r ON r.entity_id = t.entity_id AND r.type = 'community'
     WHERE p.post_id = ANY($1::text[])`,
    [postIDs],
  );
  const byPost = new Map(destinations.map((row) => [String(row.post_id), row]));
  const scoped = candidates.filter(
    (item) => item.community_entity_id || byPost.has(String(item.target?.supportingID)),
  );
  if (!scoped.length) return;
  const references = [...new Set(scoped.map((item) => String(item.referenceID)))];
  const { rows: activities } = await client.query(
    `SELECT a.*, COALESCE(u.username, r.slug, b.handle) AS handle
     FROM (
       SELECT 'comment' AS kind, c.comment_id AS reference_id, c.post_id,
              c.entity_id AS actor_id, c.is_anonymous, c.deleted_at IS NULL AS live
       FROM newsfeed_comment c WHERE c.comment_id = ANY($1::text[])
       UNION ALL
       SELECT 'post_reaction', x.reaction_id, x.post_id, x.entity_id, x.is_anonymous, TRUE
       FROM newsfeed_reaction x WHERE x.reaction_id = ANY($1::text[])
       UNION ALL
       SELECT 'comment_reaction', x.reaction_id, c.post_id, x.entity_id, x.is_anonymous, c.deleted_at IS NULL
       FROM newsfeed_commentreaction x JOIN newsfeed_comment c ON c.comment_id = x.comment_id
       WHERE x.reaction_id = ANY($1::text[])
     ) a
     LEFT JOIN user_account u ON u.entity_id = a.actor_id
     LEFT JOIN community_realm r ON r.entity_id = a.actor_id
     LEFT JOIN bot_bot b ON b.entity_id = a.actor_id`,
    [references],
  );
  const activityMap = new Map(
    activities.map((row) => [`${row.kind}:${row.reference_id}`, row]),
  );
  for (const item of scoped) {
    const destination = byPost.get(String(item.target?.supportingID));
    const communityID = String(
      destination?.community_entity_id || item.community_entity_id,
    );
    const kind = ["post_reaction", "comment_reaction"].includes(item.type)
      ? item.type : "comment";
    const activity = activityMap.get(`${kind}:${item.referenceID}`);
    const current = activity && activity.live &&
      String(activity.post_id) === String(item.target?.supportingID);
    const anonymous = !current || activity.is_anonymous;
    item.community_entity_id = communityID;
    item.community_name = destination?.community_name || item.community_name || null;
    if (
      item.type === "community_activity" &&
      String(item.referenceID) === String(item.target?.supportingID) &&
      destination?.from_system &&
      destination.details?.community_media_update === true &&
      String(destination.post_author_id) === communityID
    ) {
      item.is_anonymous = false;
      item.fromUserID = communityID;
      continue;
    }
    item.is_anonymous = Boolean(anonymous);
    item.fromUserID = anonymous ? communityID : String(activity.actor_id);
    const verbs = {
      post_reaction: "reacted",
      comment_reaction: "reacted to a comment",
      comment_mention: "mentioned you",
    };
    const verb = verbs[item.type] ||
      (item.content?.headline === "Replied Comment" ? "replied" : "commented");
    const subject = anonymous
      ? "An anonymous member"
      : activity.handle ? `@${activity.handle}` : "A member";
    const postLabel = String(item.toUserID) === String(destination?.post_author_id)
      ? "your post" : "a post";
    item.content = {
      ...item.content,
      details: current
        ? `${subject} ${verb} on ${postLabel} in the community.`
        : "New activity in your community.",
    };
  }
};

module.exports = {
  MANAGEMENT_NOTIFICATION_TYPES,
  isCommunityManagementNotification,
  notificationSortStages,
  notificationAudienceMatch,
  notificationReadMatch,
  canManageCommunityNotifications,
  authorizedNotificationStream,
  normalizeCommunityNotifications,
};
