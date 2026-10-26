const communityError = (message, status = 400) =>
  Object.assign(new Error(message), { status, publicMessage: message });

const parseAnonymousFlag = (value) => {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw communityError("is_anonymous must be a boolean");
  }
  return value;
};

// Called inside the post transaction. Sharing the realm and membership locks
// keeps a concurrent leave/removal or privacy change from changing its audience
// between validation and insertion.
const resolveCommunityDestination = async (client, entityID, payload, kind) => {
  const anonymous = parseAnonymousFlag(payload.is_anonymous);
  const destination = payload.community_entity_id;

  if (destination === undefined || destination === null || destination === "") {
    if (anonymous) {
      throw communityError("Anonymous posts are only available in communities");
    }
    return null;
  }

  if (typeof destination !== "string" || !destination.trim()) {
    throw communityError("Select one community to post in");
  }
  if (kind !== "feed") {
    throw communityError("Only feed posts can be posted in a community");
  }

  const { rows } = await client.query(
    `SELECT r.realm_id, r.entity_id, r.is_private
     FROM community_realm r
     JOIN community_member m ON m.realm_id = r.id AND m.entity_id = $2
     WHERE r.entity_id = $1 AND r.type = 'community' AND r.is_active = TRUE
     FOR SHARE OF r, m`,
    [destination.trim(), entityID],
  );

  if (rows.length !== 1) {
    throw communityError("Join this community before posting in it", 403);
  }
  return rows[0];
};

// Only the authenticated realm-media route calls the trusted post helper.
// This resolves its author from the realm row instead of accepting an author
// identity from a request, and locks that row while its photo/post are updated.
const loadCommunityMediaRealm = async (client, realmID, lock = false) => {
  const { rows } = await client.query(
    `SELECT r.realm_id, r.entity_id, r.is_private, r.profile, r.cover_photo
     FROM community_realm r
     WHERE r.realm_id = $1 AND r.type = 'community' AND r.is_active = TRUE
     ${lock ? "FOR UPDATE OF r" : ""}`,
    [realmID],
  );
  if (rows.length !== 1) {
    throw communityError("Community not available", 404);
  }
  return rows[0];
};

const loadPostCommunity = async (client, postID, viewerID) => {
  const { rows } = await client.query(
    `SELECT r.entity_id, r.realm_id, r.is_private, r.is_active,
            EXISTS (
              SELECT 1 FROM community_member m
              WHERE m.realm_id = r.id AND m.entity_id = $2
            ) AS is_member
     FROM newsfeed_posttag t
     JOIN community_realm r ON r.entity_id = t.entity_id
     WHERE t.post_id = $1 AND r.type = 'community'
     LIMIT 2`,
    [postID, viewerID],
  );
  if (rows.length > 1) {
    throw communityError("Post not available", 404);
  }
  return rows[0] || null;
};

const validateCommunityInteraction = (community, requestedAnonymity) => {
  const anonymous = parseAnonymousFlag(requestedAnonymity);
  if (community && !community.is_member) {
    throw communityError("Join this community before interacting", 403);
  }
  if (anonymous && !community) {
    throw communityError("Anonymity is only available in communities");
  }
  return anonymous;
};

const validateCommunityShare = (source, destination) => {
  if (
    source &&
    (!source.is_active ||
      (source.is_private && source.entity_id !== destination?.entity_id))
  ) {
    throw communityError("This post cannot be shared outside its community", 403);
  }
};

const validateAnonymousUploads = (records, community) => {
  const prefix = community ? `uploads/communities/${community.entity_id}/` : null;
  if (!prefix || records.some((record) => !record.key?.startsWith(prefix))) {
    throw communityError("Upload anonymous media for this community before attaching it");
  }
};

// Scope is determined by the destination tag, never by the author's realm.
// NOT EXISTS is used for ordinary posts to avoid duplicate rows from tag joins.
const communityScopeSQL = (postAlias, selection = "1") => `
  SELECT ${selection} FROM newsfeed_posttag community_tag
  JOIN community_realm community ON community.entity_id = community_tag.entity_id
  WHERE community_tag.post_id = ${postAlias}.post_id
    AND community.type = 'community'`;

const communityAudienceSQL = (postAlias, viewerParam) => `(
  (${communityScopeSQL(postAlias, "COUNT(DISTINCT community.id)")}) = 1
  AND ${postAlias}.on_feed = 'feed'
  AND NOT EXISTS (
    ${communityScopeSQL(postAlias)}
    AND (
      community.is_active = FALSE
      OR (community.is_private = TRUE AND NOT EXISTS (
        SELECT 1 FROM community_member community_member
        WHERE community_member.realm_id = community.id
          AND community_member.entity_id = ${viewerParam}
      ))
    )
  )
)`;

module.exports = {
  communityAudienceSQL,
  communityScopeSQL,
  loadPostCommunity,
  loadCommunityMediaRealm,
  parseAnonymousFlag,
  resolveCommunityDestination,
  validateCommunityInteraction,
  validateCommunityShare,
  validateAnonymousUploads,
};
