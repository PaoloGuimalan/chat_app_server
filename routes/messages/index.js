require("dotenv").config()
const express = require("express")
const router = express.Router()
const mongoose = require("mongoose")
const jwt = require("jsonwebtoken")
const Axios = require("axios")

const UserAccount = require("../../schema/auth/useraccount")
const UserVerification = require("../../schema/auth/userverification")
const UserMessage = require('../../schema/messages/message')
const { jwtchecker } = require("../../reusables/hooks/jwthelper")
const { GetMessageReceivers } = require("../../reusables/models/messages")
const { MessagesTrigger } = require("../../reusables/hooks/sse")

const MAILINGSERVICE_DOMAIN = process.env.MAILINGSERVICE
const JWT_SECRET = process.env.JWT_SECRET

const ssexpresssample = (req, res, next) => {
    console.log("SSE SAMPLE MIDDLEWARE")
    next()
}

router.get('/getMessages', [jwtchecker, ssexpresssample], (req, res) => {
    res.send({status: true, message: "getMessages Testing endpoint"})
})

router.post('/deletemessage', jwtchecker, (req, res) => {
    const token = req.body.token;
    const userID = req.params.userID;

    try{
        const decodedToken = jwt.verify(token, JWT_SECRET);

        // console.log(decodedToken);

        UserMessage.updateOne({ conversationID: decodedToken.conversationID, messageID: decodedToken.messageID }, { isDeleted: true }).then( async (result) => {
            const messageReceivers = await GetMessageReceivers(decodedToken.conversationID, decodedToken.messageID);
            
            messageReceivers.map((user) => {
                MessagesTrigger(user, userID, false);
            })

            res.send({ status: true, message: "OK" })
        }).catch((err) => {
            res.send({ status: false, message: err.message })
        })
    }catch(ex){
        console.log(ex);
        res.send({ status: false, message: "Error decoding token" })
    }
})

module.exports = router;

