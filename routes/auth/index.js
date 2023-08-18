require("dotenv").config()
const express = require("express")
const router = express.Router()
const mongoose = require("mongoose")
const jwt = require("jsonwebtoken")

const makeID = require("../../reusables/hooks/makeID")
const dateGetter = require("../../reusables/hooks/getDate")
const timeGetter = require("../../reusables/hooks/getTime")

const UserAccount = require("../../schema/auth/useraccount")

const jwtchecker = (req, res, next) => {
    const token = req.headers["x-access-token"]

    if(token){
        jwt.verify(token, process.env.JWT_SECRET, (err, decode) => {
            if(err){
                console.log(err)
                res.send({ status: false, message: err.message })
            }
            else{
                const id = decode.userID;
                req.params.userID = id;
                next()
            }
        })
    }
    else{
        res.send({ status: false, message: "Cannot verify user!"})
    }
}

router.use((req, res, next) => {
    next()
})

router.get('/users', jwtchecker, async (req, res) => {
    await UserAccount.find({}).then((result) => {
        res.send({status: true, result: result})
    }).catch((err) => {
        console.log(err)
        res.send({status: false, err: err.message})
    })
    
})

const checkUserIDExisting = async (nameID, IDMade) => {
    const combineID = `${nameID}_${IDMade}`;

    return await UserAccount.find({userID: combineID}).then((result) => {
        if(result.length){
            checkUserIDExisting(nameID, makeID(10))
        }
        else{
            return combineID;
        }
    }).catch((err) => {
        console.log(err)
    })
}

router.post('/register', async (req, res) => {
    const firstName = req.body.fullname.firstName;
    const middleName = req.body.fullname.middleName && req.body.fullname.middleName.trim() != ""? req.body.fullname.middleName : "N/A";
    const lastName = req.body.fullname.lastName;
    const email = req.body.email;
    const password = req.body.password;

    const userID = await checkUserIDExisting(firstName.trim().toLowerCase(), makeID(10))
    const date = dateGetter()
    const time = timeGetter()
    const isActivated = true;
    const isVerified = true;

    const newUser = new UserAccount({
        userID: userID,
        fullname: {
            firstName: firstName,
            middleName: middleName,
            lastName: lastName
        },
        email: email,
        password: password,
        dateCreated: {
            date: date,
            time: time
        },
        isActivated: isActivated,
        isVerified: isVerified
    })

    newUser.save().then(() => {
        res.send({status: true, message: "You have been registered"})
    }).catch((err) => {
        console.log(err)
        res.send({status: false, message: "Error registering account!"})
    })
})

module.exports = router;