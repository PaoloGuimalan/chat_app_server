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
};
