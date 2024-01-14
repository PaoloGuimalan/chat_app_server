require("dotenv").config()
const express = require("express")
const jwt = require("jsonwebtoken")
const { sseNotificationsWaiters } = require("../../reusables/hooks/sse")
const dateGetter = require("../../reusables/hooks/getDate")
const timeGetter = require("../../reusables/hooks/getTime")
const makeID = require("../../reusables/hooks/makeID")
const { jwtchecker } = require("../../reusables/hooks/jwthelper")
const router = express.Router();

const UserAccount = require("../../schema/auth/useraccount")

router.get('/userinfo/:profileUserID', jwtchecker, (req, res) => {
    const profileUserID = req.params.profileUserID;

    UserAccount.findOne({ userID: profileUserID }, { password: 0 }).then((result) => {
        res.send({ status: true, result: result });
    }).catch((err) => {
        console.log(err);
        res.send({ status: false, message: err.message });
    })
})

module.exports = router;