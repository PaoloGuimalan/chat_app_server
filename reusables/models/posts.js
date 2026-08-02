const Posts = require("../../schema/posts/posts");
const makeid = require("../hooks/makeID");
const pool = require("../database/postgres");

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

const updateRankingScore = async (postID, updateType, isDecrease) => {
  const { rows: postDataRaw } = await pool.query(
    "SELECT date_posted FROM newsfeed_post WHERE post_id = $1",
    [postID]
  );

  const { rows } = await pool.query(
    "SELECT * FROM newsfeed_postscore WHERE post_id = $1",
    [postID]
  );

  const postData = postDataRaw.length === 1 ? postDataRaw[0] : null;

  if (rows.length > 0) {
    if (rows.length === 1) {
      const postScore = rows[0];

      // Initialize values from DB
      let newRecentUpdateBoost = parseFloat(postScore.recent_update_boost);
      const finalContentScore = parseFloat(postScore.content_type_weight);
      const reactions = parseInt(postScore.likes_count, 10);
      const commentsCount = parseInt(postScore.comments_count, 10);
      const sharesCount = parseInt(postScore.shares_count, 10);

      // Adjust recent_update_boost based on updateType and isDecrease
      const boostValues = {
        react: 0.1,
        comment: 0.3,
        share: 0.5,
        default: 0.1,
      };
      const boost = boostValues[updateType] ?? boostValues.default;
      newRecentUpdateBoost = isDecrease
        ? newRecentUpdateBoost - boost
        : newRecentUpdateBoost + boost;

      // Calculate age in hours
      const now = new Date();
      const datePosted = new Date(postData.date_posted);
      const ageHours = (now - datePosted) / (1000 * 3600);

      const affinityScore = 1.0;
      const contentTypeWeight = finalContentScore;
      const recentUpdateBoost = newRecentUpdateBoost;
      const likesCount = reactions;

      // Calculate weighted engagement
      const baseEngagement = 1;
      const weightedEngagement =
        commentsCount * 3 + likesCount * 1 + sharesCount * 5 + baseEngagement;

      // Decay factor
      const decayFactor = Math.sqrt(ageHours + 1);

      // Ranking score calculation
      const rankingScore =
        (weightedEngagement / decayFactor) *
        affinityScore *
        contentTypeWeight *
        recentUpdateBoost;

      // Insert or update postscore table
      const insertPostScore = `
        INSERT INTO newsfeed_postscore (affinity_score, content_type_weight, recent_update_boost, likes_count, comments_count, shares_count, ranking_score, post_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (post_id) DO UPDATE SET
          affinity_score = EXCLUDED.affinity_score,
          content_type_weight = EXCLUDED.content_type_weight,
          recent_update_boost = EXCLUDED.recent_update_boost,
          likes_count = EXCLUDED.likes_count,
          comments_count = EXCLUDED.comments_count,
          shares_count = EXCLUDED.shares_count,
          ranking_score = EXCLUDED.ranking_score;
      `;

      await pool.query(insertPostScore, [
        affinityScore,
        contentTypeWeight,
        recentUpdateBoost,
        likesCount,
        commentsCount,
        sharesCount,
        rankingScore,
        postID,
      ]);
    } else {
      console.log(`WARNING: Too many posts to resolve`);
    }
  } else {
    console.log(`WARNING: No Post Score for Post: ${postID}`);
  }
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

module.exports = {
  checkPostIDExisting,
  GetAllPostsCountInProfile,
  updateRankingScore,
  ResolvePostPrivacyStatus,
  POST_PRIVACY_LEVELS,
};
