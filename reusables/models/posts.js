const { randomUUID } = require("crypto");
const Posts = require("../../schema/posts/posts");
const makeid = require("../hooks/makeID");
const pool = require("../database/postgres");
const { publish, QUEUES } = require("../rabbitmq/workqueue");
const { isModerationServiceOnline } = require("../redis/pubsub");

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

module.exports = {
  checkPostIDExisting,
  GetAllPostsCountInProfile,
  updateRankingScore,
  createPostScore,
  queueContentTagging,
  ResolvePostPrivacyStatus,
  POST_PRIVACY_LEVELS,
};
