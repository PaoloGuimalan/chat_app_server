const { randomUUID } = require("crypto");
const Posts = require("../../schema/posts/posts");
const makeid = require("../hooks/makeID");
const pool = require("../database/postgres");
const { publish, QUEUES } = require("../rabbitmq/workqueue");
const { isModerationServiceOnline } = require("../redis/pubsub");
const cassandra = require("cassandra-driver");
const { query: cassandraQuery } = require("../database/cassandra");

const checkPostIDExisting = async (currentID) => {
  const { rows } = await pool.query(
    "SELECT * FROM newsfeed_post WHERE post_id = $1",
    [currentID]
  );

  if (rows.length > 0) {
    checkPostIDExisting(makeid(30));
  } else {
    return currentID;
  }

  //   return await Posts.find({ postID: currentID })
  //     .then((result) => {
  //       if (result.length > 0) {
  //         checkPostIDExisting(makeid(30));
  //       } else {
  //         return currentID;
  //       }
  //     })
  //     .catch((err) => {
  //       console.log(err);
  //       return false;
  //     });
};

/**
 * Hands a ranking recalculation to the worker.
 *
 * The worker also moves the counter for `updateType` as part of recomputing the
 * score, so callers must NOT increment likes/comments/shares themselves - doing
 * both counts twice.
 */
const updateRankingScore = async (postID, updateType, isDecrease) => {
  await publish(QUEUES.UPDATE_RANKING_SCORE, {
    post_id: String(postID),
    update_type: updateType,
    is_decrease: !!isDecrease,
  });
};

/**
 * Seed a brand-new post's score row.
 *
 * date_posted goes out as RFC3339, which is what the handler parses.
 */
const createPostScore = async (postID, datePosted) => {
  await publish(QUEUES.CREATE_POST_SCORE_FOR_NEW_POST, {
    post_id: String(postID),
    date_posted: (datePosted ? new Date(datePosted) : new Date()).toISOString(),
  });
};

const GetAllPostsCountInProfile = async (userID) => {
  return await Posts.count({
    $or: [{ userID: userID }, { "tagging.users": userID }],
  }).then((result) => {
    return result;
  });
};

const POST_PRIVACY_LEVELS = ["public", "connections", "private", "custom"];

/**
 * What a newsfeed_post row IS, stored in on_feed.
 *
 * Django mirror: newsfeed/models.py PostKind (the schema of record). Which
 * kinds each LIST read returns lives only in Django (newsfeed/services/
 * post_kinds.py) - nothing in Node lists posts.
 */
const POST_KINDS = Object.freeze({
  FEED: "feed",
  MOMENT: "moment",
  THOUGHT: "thought",
});

// Moments and thoughts live 24h. Django mirror: EPHEMERAL_LIFETIME.
const EPHEMERAL_LIFETIME_MS = 24 * 60 * 60 * 1000;

// A thought's text limit, counted in code points.
const THOUGHT_MAX_LENGTH = 60;

// A moment's caption limit, counted in code points.
const MOMENT_CAPTION_MAX_LENGTH = 120;

// A thought's optional mood. Django mirror: newsfeed/models.py THOUGHT_MOODS.
const THOUGHT_MOODS = Object.freeze([
  "chilling",
  "busy",
  "focused",
  "traveling",
  "celebrating",
  "resting",
  "hungry",
]);

// Who a moment or thought can be shown to. "Close" (a close-friends list) is
// designed but hidden until that list exists, so moments and thoughts take
// only these two - anything else falls back to the profile default.
const EPHEMERAL_AUDIENCES = Object.freeze(["public", "connections"]);

const isEphemeralKind = (kind) =>
  kind === POST_KINDS.MOMENT || kind === POST_KINDS.THOUGHT;

/**
 * The audience a new post by `entityID` should carry.
 *
 * A private profile posts to its connections by default; everyone else
 * defaults to public. Resolved SERVER-SIDE from user_account.is_private rather
 * than trusting the signed payload: the privacy field is chosen by the client
 * before the profile toggle is necessarily known to it, and an omitted or
 * unrecognised value must never fall through to "public" for a private author.
 *
 * An EXPLICIT, valid choice from the author still wins - going private sets
 * the default audience for what comes next, it does not forbid deliberately
 * posting something publicly. Anything else (missing, null, garbage) takes the
 * profile-derived default.
 *
 * Django mirror: newsfeed/services/post_visibility.py default_privacy_status_for().
 */
const ResolvePostPrivacyStatus = async (entityID, requestedStatus) => {
  if (POST_PRIVACY_LEVELS.includes(requestedStatus)) {
    return requestedStatus;
  }

  const { rows } = await pool.query(
    `
    SELECT is_private
    FROM user_account
    WHERE entity_id = $1;
    `,
    [entityID],
  );

  // No row means the author is a realm, which has no profile privacy -
  // Realm.is_private is invite-only group membership, a different concept.
  const isPrivate = rows.length > 0 && rows[0].is_private === true;

  return isPrivate ? "connections" : "public";
};

/**
 * Hand a new post to the moderation service for moderation and tagging.
 *
 * GATED ON PRESENCE. The moderation service announces itself in Redis with a
 * short TTL; when that key is absent this publishes NOTHING and the service's
 * database scour picks the post up on its next start. That is the designed
 * path, not a degraded one - which is why skipping is safe, and why nothing
 * here throws.
 *
 * Called AFTER the transaction commits. The moderation service reads
 * newsfeed_post and newsfeed_postreference, so publishing from inside the
 * transaction is a race it would usually win - same reasoning as
 * createPostScore above.
 *
 * Media items are sent even though the service records only text today. The
 * contract is settled now so enabling media there is an internal change rather
 * than a fourth service redeploy.
 */
const queueContentTagging = async ({ postID, entityID, caption, references }) => {
  if (!(await isModerationServiceOnline())) {
    return false;
  }

  const items = [];

  if (caption && String(caption).trim()) {
    items.push({
      target_id: String(postID),
      content_type: "text",
      text: String(caption),
    });
  }

  for (const reference of references || []) {
    // content_type is resolved HERE, from the mime we already hold, so the
    // moderation service never has to guess from a file extension.
    const mime = reference.referenceMediaType || "";
    const top = String(mime).split("/")[0];
    const contentType = ["image", "video", "audio"].includes(top) ? top : "file";

    items.push({
      target_id: String(reference.referenceID),
      content_type: contentType,
      url: reference.reference,
      mime,
    });
  }

  if (items.length === 0) {
    return false;
  }

  return publish(QUEUES.CONTENT_TAGGING, {
    job_id: randomUUID(),
    source_type: "post",
    target_id: String(postID),
    entity_id: String(entityID),
    // Posts are moderated, not merely contextualised.
    strict: true,
    created_at: new Date().toISOString(),
    items,
  });
};

/**
 * Whether `entityID` is allowed to read `postID`.
 *
 * Gates the post-activity SSE stream (routes/posts/index.js), which is
 * subscribed to by post id - so without this, holding any post's id would be
 * enough to watch its comment traffic and see who is typing on it, regardless
 * of the post's audience.
 *
 * Django mirror: newsfeed/services/post_visibility.py can_view_post(). The
 * four audience levels are reproduced exactly. What is NOT reproduced is that
 * function's entity_side_is_visible() predicate, which additionally drops a
 * connection whose counterpart has been deactivated or is unverified.
 * Deliberate: reproducing it here means restating a three-way user/realm/bot
 * union that has already changed once, and the only thing the omission can do
 * is let a deactivated connection keep a stream open. That stream carries ids
 * and typing pings, never comment text - every read of the content itself
 * still goes through Django's comments GET, which applies the full rule. So
 * the narrower check bounds the blast radius rather than defining it.
 *
 * Fails CLOSED: an unknown post, a deleted one, or a query that throws all
 * answer false. A stream that should have been allowed and was not is a
 * missing live update; the reverse is a leak.
 */
/**
 * The audience rule as a SQL boolean expression: may the entity bound to
 * `viewerParam` (e.g. "$2") read the newsfeed_post aliased `postAlias`.
 *
 * The four levels of post_visibility.py can_view_post(), and the one place
 * Node states them - CanEntityViewPost below and the reply-target hydrator
 * (reusables/hooks/replyTargets.js) both embed this rather than keeping copies.
 * Deletion is NOT part of it; callers decide what a deleted post means.
 */
const postVisibleToSQL = (postAlias, viewerParam) => `(
  ${postAlias}.privacy_status = 'public'
  OR ${postAlias}.entity_id = ${viewerParam}
  OR (
    ${postAlias}.privacy_status = 'connections'
    AND EXISTS (
      SELECT 1
      FROM entity_connection c
      WHERE c.status = TRUE
        AND (
          (c.action_by_id = ${postAlias}.entity_id AND c.involved_entity_id = ${viewerParam})
          OR (c.action_by_id = ${viewerParam} AND c.involved_entity_id = ${postAlias}.entity_id)
        )
    )
  )
  OR (
    ${postAlias}.privacy_status = 'custom'
    AND EXISTS (
      SELECT 1
      FROM newsfeed_postprivacy pp
      WHERE pp.post_id = ${postAlias}.post_id
        AND pp.allowed_entity_id = ${viewerParam}
    )
  )
)`;

const CanEntityViewPost = async (postID, entityID) => {
  if (!postID || !entityID) return false;

  try {
    const { rows } = await pool.query(
      `
      SELECT 1
      FROM newsfeed_post p
      WHERE p.post_id = $1
        AND p.deleted_at IS NULL
        AND ${postVisibleToSQL("p", "$2")}
      LIMIT 1;
      `,
      [String(postID), String(entityID)],
    );

    return rows.length > 0;
  } catch (err) {
    console.log("[post-activity] visibility check failed:", err.message || err);
    return false;
  }
};

/**
 * Records that `entityID` shared `postID` - the user_engagement_log row the
 * backfill and ranking read ("share" is one of the engagements that decides
 * what a new follower is shown).
 *
 * `via` is how it was shared: "feed" (reposted as a post of their own) or
 * "message" (sent into chats). Both are shares; metadata keeps them apart for
 * anything that later needs to tell them apart. `extra` is merged into it.
 *
 * Never throws - the share itself has already happened by the time this runs.
 */
const logPostShare = async (entityID, postID, via, extra = {}) => {
  try {
    await cassandraQuery(
      "INSERT INTO chatterloop.user_engagement_log " +
        "(log_id, user_id, activity_time, time_spent, activity_type, target_type, target_id, metadata, created_at, updated_at) " +
        "VALUES (?, ?, toTimestamp(now()), ?, ?, ?, ?, ?, toTimestamp(now()), toTimestamp(now()))",
      [
        cassandra.types.uuid(),
        entityID,
        0,
        "share",
        "post",
        String(postID),
        JSON.stringify({ via, ...extra }),
      ],
      { prepare: true },
    );
  } catch (err) {
    console.log("[share] engagement log failed:", err.message || err);
  }
};

module.exports = {
  logPostShare,
  checkPostIDExisting,
  GetAllPostsCountInProfile,
  updateRankingScore,
  createPostScore,
  queueContentTagging,
  ResolvePostPrivacyStatus,
  POST_PRIVACY_LEVELS,
  POST_KINDS,
  EPHEMERAL_LIFETIME_MS,
  THOUGHT_MAX_LENGTH,
  MOMENT_CAPTION_MAX_LENGTH,
  THOUGHT_MOODS,
  EPHEMERAL_AUDIENCES,
  isEphemeralKind,
  postVisibleToSQL,
  CanEntityViewPost,
};
