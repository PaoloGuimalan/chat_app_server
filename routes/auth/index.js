require("dotenv").config()
const express = require("express")
const router = express.Router()
const mongoose = require("mongoose")
const jwt = require("jsonwebtoken")
const Axios = require("axios")

const makeID = require("../../reusables/hooks/makeID")
const dateGetter = require("../../reusables/hooks/getDate")
const timeGetter = require("../../reusables/hooks/getTime")
const { encode, decode } = require("../../reusables/hooks/bycrypt")

const UserAccount = require("../../schema/auth/useraccount")
const UserVerification = require("../../schema/auth/userverification")

const MAILINGSERVICE_DOMAIN = process.env.MAILINGSERVICE

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
        return false;
    })
}

const checkVerIDExisting = async (IDMade) => {
    return await UserVerification.find({verID: IDMade}).then((result) => {
        if(result.length){
            checkVerIDExisting(makeID(20))
        }
        else{
            return IDMade;
        }
    }).catch((err) => {
        console.log(err)
        return false;
    })
}

const sendEmailVerCode = async (from, to, subject, userID) => {
    const generatedID = makeID(6)
    const content = `
    Welcome to ChatterLoop!

    Your registration was successful! Here is your verification code for the account activation: ${generatedID}
    `;

    const newVerID = await checkVerIDExisting(makeID(20))

    const newVerRecord = new UserVerification({
        verID: newVerID,
        userID: userID,
        verCode: generatedID,
        dateGenerated: {
            date: dateGetter(),
            time: timeGetter()
        },
        isUsed: false
    })

    Axios.post(`${MAILINGSERVICE_DOMAIN}/sendEmail`, {
        from: from,
        email: to,
        subject: subject,
        content: content
    }).then((response) => {
        if(response.data.status){
            //action needed to save verification code in db
            newVerRecord.save().then(() => {

            }).catch((err) => {
                console.log(err)
            })
        }
    }).catch((err) => {
        console.log(err)
    })
}

const checkEmailExisting = async (email) => {
    return await UserAccount.find({email: email}).then((result) => {
        if(result.length){
           return true
        }
        else{
            return false;
        }
    }).catch((err) => {
        console.log(err)
        return false;
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
    const isVerified = false;

    const newUser = new UserAccount({
        userID: userID,
        fullname: {
            firstName: firstName,
            middleName: middleName,
            lastName: lastName
        },
        email: email,
        password: encode(password),
        dateCreated: {
            date: date,
            time: time
        },
        isActivated: isActivated,
        isVerified: isVerified
    })

    if(await checkEmailExisting(email)){
        res.send({status: false, message: "Email already in use"})
    }
    else{
        newUser.save().then(() => {
            sendEmailVerCode("ChatterLoop", email, "Verification Code", userID)
            res.send({status: true, message: "You have been registered"})
        }).catch((err) => {
            console.log(err)
            res.send({status: false, message: "Error registering account!"})
        })
    }
})

router.post('/emailverify', (req, res) => {

})

module.exports = router;