const express = require("express")
const router = express.Router()
const mongoose = require("mongoose")
const jwt = require("jsonwebtoken")

const UserAccount = require("../../schema/auth/useraccount")

const jwtchecker = () => {
    
}

router.use((req, res, next) => {
    next()
})

router.get('/users', async (req, res) => {
    await UserAccount.find({}).then((result) => {
        res.send({status: true, result: result})
    }).catch((err) => {
        console.log(err)
        res.send({status: false, err: err.message})
    })
    
})

module.exports = router;