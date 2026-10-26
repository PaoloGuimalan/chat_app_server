// Community identity is independent of the sender. Both current actor-sender
// rows and legacy community-sender rows are checked before Mongo pagination.
const notificationAudienceMatch = async (client, match, viewerID) => {
  const { rows } = await client.query(
    `SELECT r.entity_id FROM community_realm r
     WHERE r.type = 'community'
       AND (r.is_active = FALSE OR NOT EXISTS (
         SELECT 1 FROM community_member m
         WHERE m.realm_id = r.id AND m.entity_id = $1
       ))`,
    [viewerID],
  );
  if (!rows.length) return match;
  return {
    $and: [
      match,
      { fromUserID: { $nin: rows.map((row) => row.entity_id) } },
      { community_entity_id: { $nin: rows.map((row) => row.entity_id) } },
    ],
  };
};

const authorizedNotificationStream = (response, authorize) => ({
  async sse(event, payload) {
    const target = payload?.result;
    if (target?.community_entity_id && target?.post_id) {
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
  const candidates = items.filter(
    (item) => item.community_entity_id || item.target?.type === "post",
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
    item.content = {
      ...item.content,
      details: current
        ? `${subject} ${verb} in your community.`
        : "New activity in your community.",
    };
  }
};

module.exports = {
  notificationAudienceMatch,
  authorizedNotificationStream,
  normalizeCommunityNotifications,
};
