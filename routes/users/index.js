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
    const token = req.headers["x-access-token"]

    if(token){
        jwt.verify(token, JWT_SECRET, async (err, decode) => {
            if(err){
                console.log(err)
                res.send({ status: false, message: err.message })
            }
            else{
                const id = decode.userID;
                await UserAccount.findOne({ userID: id }).then((result) => {
                    if(result){
                        req.params.userID = result.userID;
                        next()
                    }
                    else{
                        res.send({ status: false, message: "Cannot verify user!"})
                    }
                }).catch((err) => {
                    console.log(err)
                    res.send({ status: false, message: "Error verifying user!"})
                })
            }
        })
    }
    else{
        res.send({ status: false, message: "Cannot verify user!"})
    }
}

router.get('/search/:searchdata', jwtchecker, async (req, res) => {
    const userID = req.params.userID
    const searchdata = req.params.searchdata;
    
    if(searchdata.split("")[0] == "@"){
        await UserAccount.find({ isActivated: true, isVerified: true, userID: { $regex: searchdata.split("@")[1], $options: "i" }}, {
            password: 0,
            birthdate: 0,
            gender: 0,
            email: 0,
            isActivated: 0,
            isVerified: 0
        }).then((result) => {
            res.send({status: true, result: result})
        }).catch((err) => {
            console.log(err)
            res.send({status: false, message: `Error searching for ${searchdata}`})
        })
    }
    else{
        await UserAccount.find({ isActivated: true, isVerified: true, $or: [
            {"fullname.firstName": { $regex: searchdata, $options: "i" }},
            {"fullname.middleName": { $regex: searchdata, $options: "i" }},
            {"fullname.lastName": { $regex: searchdata, $options: "i" }}
        ] }, {
            password: 0,
            birthdate: 0,
            gender: 0,
            email: 0,
            isActivated: 0,
            isVerified: 0
        }).then((result) => {
            res.send({status: true, result: result})
        }).catch((err) => {
            console.log(err)
            res.send({status: false, message: `Error searching for ${searchdata}`})
        })
    }
})

module.exports = router;

