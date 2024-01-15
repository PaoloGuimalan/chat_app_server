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
    const token = req.body.token;
    
    try{
        const decodeToken = jwt.verify(token, JWT_SECRET)

        const firstName = decodeToken.fullname.firstName;
        const middleName = decodeToken.fullname.middleName && decodeToken.fullname.middleName.trim() != ""? decodeToken.fullname.middleName : "N/A";
        const lastName = decodeToken.fullname.lastName;
        const email = decodeToken.email;
        const password = decodeToken.password;
        const birthday = decodeToken.birthdate.day;
        const birthmonth = decodeToken.birthdate.month;
        const birthyear = decodeToken.birthdate.year;
        const gender = decodeToken.gender;

        const userID = await checkUserIDExisting(firstName.replace(/\s/g, "").toLowerCase(), makeID(10))
        const date = dateGetter()
        const time = timeGetter()
        const isActivated = true;
        const isVerified = false;

        const payload = {
            userID: userID,
            fullname: {
                firstName: firstName,
                middleName: middleName,
                lastName: lastName
            },
            birthdate:{
                month: birthmonth,
                day: birthday,
                year: birthyear
            },
            profile: "none",
            coverphoto: "",
            gender: gender,
            email: email,
            password: encode(password),
            dateCreated: {
                date: date,
                time: time
            },
            isActivated: isActivated,
            isVerified: isVerified
        }

        const newUser = new UserAccount(payload)

        if(await checkEmailExisting(email)){
            res.send({status: false, message: "Email already in use"})
        }
        else{
            newUser.save().then(() => {
                sendEmailVerCode("ChatterLoop", email, "Verification Code", userID)
                const usertoken = jwt.sign({
                    ...payload,
                    password: null 
                }, JWT_SECRET, {
                    expiresIn: 60 * 60 * 24 * 7
                })

                const authtoken = jwt.sign({
                    userID: payload.userID
                }, JWT_SECRET, {
                    expiresIn: 60 * 60 * 24 * 7
                })
                res.send({status: true, message: "You have been registered", result: {
                    usertoken: usertoken,
                    authtoken: authtoken
                }})
            }).catch((err) => {
                console.log(err)
                res.send({status: false, message: "Error registering account!"})
            })
        }
    }catch(ex){
        console.log(ex)
        res.send({status: false, message: "Token invalid!"})
    }
})

const updateVerCodeStatus = async (verID) => {
    await UserVerification.updateOne({verID: verID}, {isUsed: true})
}

const verifyCodeUserId = async (userIDProp, code) => {
    return await UserVerification.findOne({userID: userIDProp, verCode: code}).then((result) => {
        if(result){
           if(!result.isUsed){
               updateVerCodeStatus(result.verID)
               return true
           }
        }
        else{
            return false;
        }
    }).catch((err) => {
        console.log(err)
        return false;
    })
}

const setUserVerified = async (userIDProp) => {
    return await UserAccount.updateOne({userID: userIDProp}, {isVerified: true}).then((result) => {
        if(result.modifiedCount){
            return true;
        }
        else{
            return false;
        }
    }).catch((err) => {
        console.log(err)
        return false;
    })
}

router.post('/emailverify', jwtchecker, async (req, res) => {
    const userID = req.params.userID
    const token = req.body.token;

    try{
        const decodeToken = jwt.verify(token, JWT_SECRET)
        const verificationcode = decodeToken.code;

        if(await verifyCodeUserId(userID, verificationcode)){
            if(await setUserVerified(userID)){
                res.send({status: true, message: "Account has been verified"})
            }
            else{
                res.send({status: false, message: "Error verifying account."})
            }
        }
        else{
            res.send({status: false, message: "Invalid verification code"})
        }
    }catch(ex){
        console.log(ex)
        res.send({status: false, message: "Error verifying code"})
    }
})

router.post('/login', async (req, res) => {
    const token = req.body.token;

    try{
        const decodeToken = jwt.verify(token, JWT_SECRET)

        const emailOrUsername = decodeToken.email_username;
        const password = decodeToken.password;

        await UserAccount.findOne({ $or: [ { userID: emailOrUsername }, { email: emailOrUsername } ]}).then((result) => {
            if(result){
                const checkPass = decode(password, result.password)
                
                if(checkPass){
                    const usertoken = jwt.sign({
                        ...result._doc,
                        password: null 
                        // userID: result.userID
                    }, JWT_SECRET, {
                        expiresIn: 60 * 60 * 24 * 7
                    })

                    const authtoken = jwt.sign({
                        userID: result.userID
                    }, JWT_SECRET, {
                        expiresIn: 60 * 60 * 24 * 7
                    })

                    res.send({ status: true, result: {
                        usertoken: usertoken,
                        authtoken: authtoken
                    }})
                }
                else{
                    res.send({ status: false, message: "Wrong email or password" })
                }
            }
            else{
                res.send({ status: false, message: "Account do not exist" })
            }
        }).catch((err) => {
            console.log(err)
            res.send({ status: false, message: "Error Logging In!" })
        })
    }catch(ex){
        console.log(ex)
        res.send({status: false, message: "Token invalid!"})
    }
})

router.get('/jwtchecker', jwtchecker, async (req, res) => {
    const userID = req.params.userID;

    await UserAccount.findOne({ userID: userID }).then((result) => {
        if(result){
            const usertoken = jwt.sign({
                ...result._doc,
                password: null 
            }, JWT_SECRET, {
                expiresIn: 60 * 60 * 24 * 7
            })

            res.send({ status: true, result: {
                usertoken: usertoken
            }})
        }
    }).catch((err) => {
        console.log(err)
        res.send({ status: false, message: "Cannot fetch user!" })
    })
})

module.exports = router;