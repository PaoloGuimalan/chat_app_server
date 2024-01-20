const Posts = require("../../schema/posts/posts");
const makeid = require("../hooks/makeID");

const checkPostIDExisting = async (currentID) => {
    return await Posts.find({ postID: currentID }).then((result) => {
        if(result.length > 0){
            checkPostIDExisting(makeid(30));
        }
        else{
            return currentID;
        }
    }).catch((err) => {
        console.log(err);
        return false;
    })
}

const GetAllPostsCountInProfile = async (userID) => {
    return await Posts.count({ $or: [ { userID: userID }, { "tagging.users": userID } ] }).then((result) => {
        return result;
    })
}

module.exports = {
    checkPostIDExisting,
    GetAllPostsCountInProfile
}