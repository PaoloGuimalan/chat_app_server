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
  const { rows: postDataRaw } = await client.query(
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

      await client.query("BEGIN");
      await client.query(insertPostScore, [
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

module.exports = {
  checkPostIDExisting,
  GetAllPostsCountInProfile,
  updateRankingScore,
};
