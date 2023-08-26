require("dotenv").config()
const express = require("express")
const router = express.Router()
const mongoose = require("mongoose")
const jwt = require("jsonwebtoken")
const Axios = require("axios")

const UserAccount = require("../../schema/auth/useraccount")
const UserVerification = require("../../schema/auth/userverification")

const MAILINGSERVICE_DOMAIN = process.env.MAILINGSERVICE
const JWT_SECRET = process.env.JWT_SECRET

const jwtchecker = (req, res, next) => {
    // const token = req.headers["x-access-token"]

    // if(token){
    //     jwt.verify(token, JWT_SECRET, async (err, decode) => {
    //         if(err){
    //             console.log(err)
    //             res.send({ status: false, message: err.message })
    //         }
    //         else{
    //             const id = decode.userID;
    //             await UserAccount.findOne({ userID: id }).then((result) => {
    //                 if(result){
    //                     req.params.userID = result.userID;
    //                     next()
    //                 }
    //                 else{
    //                     res.send({ status: false, message: "Cannot verify user!"})
    //                 }
    //             }).catch((err) => {
    //                 console.log(err)
    //                 res.send({ status: false, message: "Error verifying user!"})
    //             })
    //         }
    //     })
    // }
    // else{
    //     res.send({ status: false, message: "Cannot verify user!"})
    // }
    console.log("JWT CHECK SSE")
    next()
}

const ssexpresssample = (req, res, next) => {
    console.log("SSE SAMPLE MIDDLEWARE")
    next()
}

router.get('/getMessages', [jwtchecker, ssexpresssample], (req, res) => {
    res.send({status: true, message: "getMessages Testing endpoint"})
})

module.exports = router;

