require("dotenv").config()
const express = require("express")
const router = express.Router()
const mongoose = require("mongoose")
const jwt = require("jsonwebtoken")
const Axios = require("axios")

const UserAccount = require("../../schema/auth/useraccount")
const UserVerification = require("../../schema/auth/userverification")
const UserContacts = require("../../schema/users/contacts")

const dateGetter = require("../../reusables/hooks/getDate")
const timeGetter = require("../../reusables/hooks/getTime")
const makeID = require("../../reusables/hooks/makeID")

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
        await UserAccount.aggregate([
            {
                $match: { 
                    isActivated: true, 
                    isVerified: true, 
                    userID: { $regex: searchdata.split("@")[1], $options: "i" }
                }
            },{
                $lookup:{
                    from: "contacts",
                    // localField: "userID",
                    // foreignField: "users.userID",
                    let: { actionByUserID: "$userID" },
                    pipeline: [
                        {
                          $match: {
                            $expr: {
                              $or: [
                                // {
                                //   $and: [
                                //     { $eq: [userID, "$actionBy"] },
                                //     { $in: [userID, "$users.userID"] }
                                //   ]
                                // },
                                {
                                  $and: [
                                    { $eq: [userID, "$actionBy"] }, // Assuming userID is defined
                                    { $in: ["$$actionByUserID", "$users.userID"] }
                                  ]
                                },
                                {
                                  $and: [
                                    { $eq: ["$$actionByUserID", "$actionBy"] },
                                    { $in: [userID, "$users.userID"] } // Assuming userID is defined
                                  ]
                                }
                              ]
                            }
                          }
                        }
                    ],
                    as: "contacts"
                }
            },{
                $unwind: {
                  path: "$contacts",
                  preserveNullAndEmptyArrays: true
                }
            },{
                $project:{
                    password: 0,
                    birthdate: 0,
                    gender: 0,
                    email: 0,
                    isActivated: 0,
                    isVerified: 0
                }
            }
        ]).then((result) => {
            // console.log(result)
            var encodedResult = jwt.sign({
                searchresults: result
            }, JWT_SECRET, {
                expiresIn: 60 * 60 * 24 * 7
            })

            res.send({status: true, result: encodedResult})
        }).catch((err) => {
            console.log(err)
            res.send({status: false, message: `Error searching for ${searchdata}`})
        })
    }
    else{
        await UserAccount.aggregate([
            {
                $match: { 
                    isActivated: true, 
                    isVerified: true, 
                    $or: [
                        {"fullname.firstName": { $regex: searchdata, $options: "i" }},
                        {"fullname.middleName": { $regex: searchdata, $options: "i" }},
                        {"fullname.lastName": { $regex: searchdata, $options: "i" }}
                    ] 
                }
            },{
                $lookup:{
                    from: "contacts",
                    // localField: "userID",
                    // foreignField: "users.userID",
                    let: { actionByUserID: "$userID" },
                    pipeline: [
                        {
                          $match: {
                            $expr: {
                              $or: [
                                // {
                                //   $and: [
                                //     { $eq: [userID, "$actionBy"] },
                                //     { $in: [userID, "$users.userID"] }
                                //   ]
                                // },
                                {
                                  $and: [
                                    { $eq: [userID, "$actionBy"] }, // Assuming userID is defined
                                    { $in: ["$$actionByUserID", "$users.userID"] }
                                  ]
                                },
                                {
                                  $and: [
                                    { $eq: ["$$actionByUserID", "$actionBy"] },
                                    { $in: [userID, "$users.userID"] } // Assuming userID is defined
                                  ]
                                }
                              ]
                            }
                          }
                        }
                    ],
                    as: "contacts"
                }
            },{
                $unwind: {
                  path: "$contacts",
                  preserveNullAndEmptyArrays: true
                }
            },{
                $project:{
                    password: 0,
                    birthdate: 0,
                    gender: 0,
                    email: 0,
                    isActivated: 0,
                    isVerified: 0
                }
            }
        ]).then((result) => {
            // console.log(result)
            var encodedResult = jwt.sign({
                searchresults: result
            }, JWT_SECRET, {
                expiresIn: 60 * 60 * 24 * 7
            })

            res.send({status: true, result: encodedResult})
        }).catch((err) => {
            console.log(err)
            res.send({status: false, message: `Error searching for ${searchdata}`})
        })
    }
})

const checkContactID = async (cnctID) => {
    return await UserContacts.find({contactID: cnctID}).then((result) => {
        if(result.length){
            checkContactID(makeID(20))
        }
        else{
            return cnctID;
        }
    }).catch((err) => {
        console.log(err)
        return false;
    })
}

router.post('/requestContact', jwtchecker, async (req, res) => {
    const userID = req.params.userID
    const token = req.body.token;

    try{
        const decodeToken = jwt.verify(token, JWT_SECRET)

        const contactID = await checkContactID(makeID(20))
        const addUserID = decodeToken.addUserID

        const payload = {
            contactID: contactID,
            actionBy: userID,
            actionDate: {
                date: dateGetter(),
                time: timeGetter()
            },
            status: false,
            users: [
                {
                    userID: userID
                },
                {
                    userID: addUserID
                }
            ]
        }

        const newContact = new UserContacts(payload)

        newContact.save().then(() => {
            res.send({ status: true, message: `You have sent a contact request to @${addUserID}` })
        }).catch((err) => {
            res.send({ status: false, message: "Contact request encountered an error!" })
            console.log(err)
        })
    }catch(ex){
        res.send({ status: false, message: "Contact request encountered an error!" })
        console.log(ex)
    }
})

module.exports = router;

