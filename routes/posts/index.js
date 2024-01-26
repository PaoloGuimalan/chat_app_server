require("dotenv").config()
const express = require("express")
const jwt = require("jsonwebtoken")
const { sseNotificationsWaiters, SendTagPostNotification } = require("../../reusables/hooks/sse")
const dateGetter = require("../../reusables/hooks/getDate")
const timeGetter = require("../../reusables/hooks/getTime")
const makeID = require("../../reusables/hooks/makeID")
const { jwtchecker, createJWT } = require("../../reusables/hooks/jwthelper")
const router = express.Router();

const Posts = require("../../schema/posts/posts")
const UserNotifications = require("../../schema/users/notifications")
const { checkPostIDExisting, GetAllPostsCountInProfile } = require("../../reusables/models/posts")
const { checkNotifID } = require("../../reusables/models/notifications")

const JWT_SECRET = process.env.JWT_SECRET

router.get('/userposts/:profileUserID', jwtchecker, async (req, res) => {
    const profileUserID = req.params.profileUserID;
    const range = req.headers["range"];
    const totalposts = await GetAllPostsCountInProfile(profileUserID);

    await Posts.aggregate([ //find({ userID: profileUserID }).sort({ _id: -1 }).limit(range)
        {
            "$match": {
                "$or": [
                    { "userID": profileUserID },
                    { "tagging.users": profileUserID }
                ]
            }
        },
        {
            "$lookup": {
                from: "useraccount",
                localField: "tagging.users",
                foreignField: "userID",
                as: "tagged_users"
            }
        },
        {
            $lookup:
               {
                 from: "useraccount",
                 let: { userIDPass: "$userID" },
                 pipeline: [ {
                    $match: {
                       $expr: { $eq: [ "$userID", "$$userIDPass" ] }
                    }
                  } ],
                 as: "post_owner"
               }
        },
        {
            "$unwind": "$post_owner"
        },
        {
            "$sort": {
                "_id": -1
            }
        },
        {
            "$limit": parseInt(range)
        },
        {
            "$project": {
                "tagged_users.dateCreated": 0,
                "tagged_users.email": 0,
                "tagged_users.password": 0,
                "post_owner.dateCreated": 0,
                "post_owner.email": 0,
                "post_owner.password": 0
            }
        }
    ]).then((result) => {
        var posts = result;
        // console.log(result)
        const encodedResult = createJWT({
            posts: posts,
            total: totalposts
        });

        res.send({ status: true, result: encodedResult });
    }).catch((err) => {
        res.send({ status: false, message: err.message });
        console.log(err);
    })
})

const notifyTaggedUser = async (userID, postID, tagged_users) => {
    tagged_users.map(async (mp) => {
        const awaitNotifID = await checkNotifID(`NTF_${makeID(20)}`)
        const notifParams = {
            notificationID: awaitNotifID,
            referenceID: postID,
            referenceStatus: false,
            toUserID: mp,
            fromUserID: userID,
            content: {
                headline: `You were tagged`,
                details: `@${userID} tagged you on a post.`,
            },
            date: {
                date: dateGetter(),
                time: timeGetter()
            },
            type: "tag_notification"
        }

        const newNotif = new UserNotifications(notifParams);
    
        newNotif.save().then(() => {
            SendTagPostNotification(`@${userID} tagged you on a post.`, mp)
            // sseNotificationstrigger(type, sendFromUser, actionlog)
        }).catch((err) => { console.log(err) })
    })
}

router.post('/createpost', jwtchecker, async (req, res) => {
    const userID = req.params.userID;
    const postID = await checkPostIDExisting(makeID(30));
    const currentTimestampInSeconds = Math.floor(Date.now() / 1000);
    
    const token = req.body.token;

    try{
        const decodeToken = jwt.verify(token, JWT_SECRET);

        const payload = {
            postID: postID,
            userID: userID,
            isSponsored: false,
            isLive: false,
            isOnMap: {
                status: false,
                isStationary: true
            },
            fromSystem: true,
            dateposted: currentTimestampInSeconds,
            ...decodeToken
        }

        // console.log(userID, payload);

        const newPost = new Posts(payload);

        newPost.save().then(() => {
            // use sse to return response with data
            if(decodeToken.tagging.isTagged){
                notifyTaggedUser(userID, postID, decodeToken.tagging.users)
            }
            res.send({ status: true, result: "OK" })
        }).catch((err) => {
            res.send({ status: false, message: err.message })
            console.log(err);
        })
    }
    catch(ex){
        console.log(ex)
        res.send({ status: false, message: "Cannot decode token" })
    }
})

module.exports = router;