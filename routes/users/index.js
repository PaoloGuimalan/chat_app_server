require("dotenv").config()
const express = require("express")
const router = express.Router()
const mongoose = require("mongoose")
const jwt = require("jsonwebtoken")
const Axios = require("axios")
const sse = require("sse-express")

const UserAccount = require("../../schema/auth/useraccount")
const UserVerification = require("../../schema/auth/userverification")
const UserContacts = require("../../schema/users/contacts")
const UserNotifications = require("../../schema/users/notifications")
const UserMessage = require('../../schema/messages/message')

const dateGetter = require("../../reusables/hooks/getDate")
const timeGetter = require("../../reusables/hooks/getTime")
const makeID = require("../../reusables/hooks/makeID")

const MAILINGSERVICE_DOMAIN = process.env.MAILINGSERVICE
const JWT_SECRET = process.env.JWT_SECRET

let sseNotificationsWaiters = Object.create(null)

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

const jwtssechecker = (req, res, next) => {
    const decodedToken = jwt.verify(req.params.token, JWT_SECRET)

    const token = decodedToken.token
    const type = decodedToken.type

    if(token){
        jwt.verify(token, JWT_SECRET, async (err, decode) => {
            if(err){
                console.log(err)
                res.sse(type, { status: false, auth: false, message: err.message })
            }
            else{
                const id = decode.userID;
                await UserAccount.findOne({ userID: id }).then((result) => {
                    if(result){
                        req.params.userID = result.userID;
                        next()
                    }
                    else{
                        res.sse(type, { status: false, auth: false, message: "Cannot verify user!"})
                    }
                }).catch((err) => {
                    console.log(err)
                    res.sse(type, { status: false, auth: false, message: "Error verifying user!"})
                })
            }
        })
    }
    else{
        res.send(type, { status: false, auth: false, message: "Cannot verify user!"})
    }
}

const notificicationTrigger = async (type, id, details, sseWithUserID) => {
    await UserNotifications.aggregate([
        {
            $match:{
                toUserID: id
            }
        },{
            $lookup:{
                from: "useraccount",
                localField: "fromUserID",
                foreignField: "userID",
                as: "fromUser"
            }
        },{
            $unwind:{
                path: "$fromUser",
                preserveNullAndEmptyArrays: true
            }
        },{
            $sort: {_id: -1}
        },{
            $project:{
                "fromUser._id": 0,
                "fromUser.birthdate": 0,
                "fromUser.gender": 0,
                "fromUser.email": 0,
                "fromUser.password": 0,
                "fromUser.dateCreated": 0
            }
        }
    ]).then((result) => {
        // console.log(result)
        var encodedResult = jwt.sign({
            notifications: result
        }, JWT_SECRET, {
            expiresIn: 60 * 60 * 24 * 7
        })

        sseWithUserID.response.map((itr, i) => {
            itr.sse(`notifications`, {
                status: true,
                auth: true,
                message: details,
                result: encodedResult
            })
        })
    }).catch((err) => {
        console.log(err)
        sseWithUserID.response.map((itr, i) => {
            itr.sse(`notifications`, {
                status: false,
                auth: true,
                message: "Error retrieving notifications"
            })
        })
    })
}

const contactListTrigger = async (type, id, details, sseWithUserID) => {
    const userID = id

    await UserContacts.aggregate([
        {
            $match:{
                $and:[
                    {
                        $or:[
                            { actionBy: userID },
                            { "users.userID": userID }
                        ]
                    },
                    {
                        status: true
                    }
                ]
            }
        },{
            $lookup:{
                from: "contacts",
                localField: "contactID",
                foreignField: "contactID",
                let: { 
                    firstUserID: { $arrayElemAt: ['$users.userID', 0] },
                    secondUserID: { $arrayElemAt: ['$users.userID', 1] } 
                },
                pipeline: [
                    {
                        $lookup:{
                            from: "useraccount",
                            pipeline:[
                                {
                                    $match: {
                                        $expr:{
                                            $and: [
                                                {$eq: ["$userID", "$$firstUserID"]},
                                                {$eq: ["$isVerified", true]},
                                                {$eq: ["$isActivated", true]}
                                            ]
                                        }
                                    }
                                }
                            ],
                            as: "userone"
                        }
                    },
                    {
                        $unwind:{
                            path: "$userone",
                            preserveNullAndEmptyArrays: true
                        }
                    },
                    {
                        $lookup:{
                            from: "useraccount",
                            pipeline:[
                                {
                                    $match: {
                                        $expr:{
                                            $and: [
                                                {$eq: ["$userID", "$$secondUserID"]},
                                                {$eq: ["$isVerified", true]},
                                                {$eq: ["$isActivated", true]}
                                            ]
                                        }
                                    }
                                }
                            ],
                            as: "usertwo"
                        }
                    },
                    {
                        $unwind:{
                            path: "$usertwo",
                            preserveNullAndEmptyArrays: true
                        }
                    }
                ],
                as: "userdetails"
            }
        },{
            $unwind:{
                path: "$userdetails",
                preserveNullAndEmptyArrays: true
            }
        },{
            $project:{
                "userdetails.actionBy": 0,
                "userdetails.actionDate": 0,
                "userdetails.contactID": 0,
                "userdetails.status": 0,
                "userdetails.users": 0,
                "users": 0,
                "userdetails.userone.birthdate": 0,
                "userdetails.userone.dateCreated": 0,
                "userdetails.userone.email": 0,
                "userdetails.userone.gender": 0,
                "userdetails.userone.isActivated": 0,
                "userdetails.userone.isVerified": 0,
                "userdetails.userone.password": 0,
                "userdetails.usertwo.birthdate": 0,
                "userdetails.usertwo.dateCreated": 0,
                "userdetails.usertwo.email": 0,
                "userdetails.usertwo.gender": 0,
                "userdetails.usertwo.isActivated": 0,
                "userdetails.usertwo.isVerified": 0,
                "userdetails.usertwo.password": 0
            }
        },{
            $sort: {_id: -1}
        }
    ]).then((result) => {
        // console.log(result)
        const encodedResult = jwt.sign({
            contacts: result
        }, JWT_SECRET, {
            expiresIn: 60 * 60 * 24 * 7
        })

        sseWithUserID.response.map((itr, i) => {
            itr.sse(`contactslist`, {
                status: true,
                auth: true,
                message: details,
                result: encodedResult
            })
        })

        // res.send({ status: true, result: encodedResult })

    }).catch((err) => {
        console.log(err)
        sseWithUserID.response.map((itr, i) => {
            itr.sse(`contactslist`, {
                status: false,
                auth: true,
                message: "Error fetching contacts list"
            })
        })

        // res.send({ status: false, message: "Error fetching contacts list" })
    })
}

const sseNotificationstrigger = async (type, ids, details) => {
    const sseWithUserID = sseNotificationsWaiters[ids.sendFromUser]
    const sseWithUserIDRes = sseNotificationsWaiters[ids.sendToUser]

    if(sseWithUserID){
        if(ids.sendFromUser){
            // console.log(ids.sendFromUser)
            if(type == "info_contact_decline"){
                notificicationTrigger(type, ids.sendFromUser, details.actionlog, sseWithUserID)
            }
            else if(type == "info_contact_accept"){
                notificicationTrigger(type, ids.sendFromUser, details.actionlog, sseWithUserID)
                contactListTrigger(type, ids.sendFromUser, details.actionlog, sseWithUserID)
            }
            else if(type == "contact_request"){
                notificicationTrigger(type, ids.sendFromUser, details.actionlog, sseWithUserID)
            }
        }
    }

    if(sseWithUserIDRes){
        if(ids.sendToUser){
            // console.log(ids.sendToUser)
            if(type == "info_contact_decline"){
                notificicationTrigger(type, ids.sendToUser, details.sendToDetails, sseWithUserIDRes)
            }
            else if(type == "info_contact_accept"){
                notificicationTrigger(type, ids.sendToUser, details.sendToDetails, sseWithUserIDRes)
                contactListTrigger(type, ids.sendToUser, details.sendToDetails, sseWithUserIDRes)
            }
            else if(type == "contact_request"){
                notificicationTrigger(type, ids.sendToUser, details.sendToDetails, sseWithUserIDRes)
            }
        }
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
                                    { $eq: [userID, "$actionBy"] },
                                    { $in: ["$$actionByUserID", "$users.userID"] }
                                  ]
                                },
                                {
                                  $and: [
                                    { $eq: ["$$actionByUserID", "$actionBy"] },
                                    { $in: [userID, "$users.userID"] }
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
                $lookup:{
                    from: "notifications",
                    localField: "contacts.contactID",
                    foreignField: "referenceID",
                    as: "notification"
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
                                    { $eq: [userID, "$actionBy"] },
                                    { $in: ["$$actionByUserID", "$users.userID"] }
                                  ]
                                },
                                {
                                  $and: [
                                    { $eq: ["$$actionByUserID", "$actionBy"] },
                                    { $in: [userID, "$users.userID"] }
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
                $lookup:{
                    from: "notifications",
                    localField: "contacts.contactID",
                    foreignField: "referenceID",
                    as: "notification"
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

const sendNotification = async (params, actionlog) => {
    const sendToUser = params.toUserID
    const sendToDetails = params.content.details
    const sendFromUser = params.fromUserID
    const type = params.type
    const newNotif = new UserNotifications(params)
    
    newNotif.save().then(() => {
        sseNotificationstrigger(type, {
            sendToUser: sendToUser,
            sendFromUser: sendFromUser
        }, {
            sendToDetails: sendToDetails,
            actionlog: actionlog
        })
        // sseNotificationstrigger(type, sendFromUser, actionlog)
    }).catch((err) => { console.log(err) })
}

const checkContactID = async (cnctID) => {
    return await UserContacts.find({contactID: cnctID}).then((result) => {
        if(result.length){
            checkContactID(`${makeID(20)}`)
        }
        else{
            return cnctID;
        }
    }).catch((err) => {
        console.log(err)
        return false;
    })
}

const checkNotifID = async (ntfID) => {
    return await UserNotifications.find({notificationID: ntfID}).then((result) => {
        if(result.length){
            checkNotifID(`NTF_${makeID(20)}`)
        }
        else{
            return ntfID;
        }
    }).catch((err) => {
        console.log(err)
        return false;
    })
}

const checkContactRequest = async (requesterID, responderID) => {
    return await UserContacts.find({ "users.userID": { $all: [requesterID, responderID] } }).then((result) => {
        if(result.length > 0){
            return false
        }
        else{
            return true
        }
    }).catch((err) => {
        console.log(err)
        return false
    })
}

router.post('/requestContact', jwtchecker, async (req, res) => {
    const userID = req.params.userID
    const token = req.body.token;

    try{
        const decodeToken = jwt.verify(token, JWT_SECRET)

        const contactID = await checkContactID(`${makeID(20)}`)
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

        if(await checkContactRequest(userID, addUserID)){
            const newContact = new UserContacts(payload)

            newContact.save().then(async () => {
                const awaitNotifID = await checkNotifID(`NTF_${makeID(20)}`)
                const notifParams = {
                    notificationID: awaitNotifID,
                    referenceID: contactID,
                    referenceStatus: false,
                    toUserID: addUserID,
                    fromUserID: userID,
                    content: {
                        headline: `Contact Request`,
                        details: `${userID} have sent a contact request for you.`,
                    },
                    date: {
                        date: dateGetter(),
                        time: timeGetter()
                    },
                    type: "contact_request"
                }

                sendNotification(notifParams, "You have sent a contact request")

                res.send({ status: true, message: `You have sent a contact request to @${addUserID}` })
            }).catch((err) => {
                res.send({ status: false, message: "Contact request encountered an error!" })
                console.log(err)
            })
        }
    }catch(ex){
        res.send({ status: false, message: "Contact request encountered an error!" })
        console.log(ex)
    }
})

router.get('/getNotifications', jwtchecker, async (req, res) => {
    const userID = req.params.userID

    await UserNotifications.aggregate([
        {
            $match:{
                toUserID: userID
            }
        },{
            $lookup:{
                from: "useraccount",
                localField: "fromUserID",
                foreignField: "userID",
                as: "fromUser"
            }
        },{
            $unwind:{
                path: "$fromUser",
                preserveNullAndEmptyArrays: true
            }
        },{
            $sort: {_id: -1}
        },{
            $project:{
                "fromUser._id": 0,
                "fromUser.birthdate": 0,
                "fromUser.gender": 0,
                "fromUser.email": 0,
                "fromUser.password": 0,
                "fromUser.dateCreated": 0
            }
        }
    ]).then((result) => {
        // console.log(result)
        var encodedResult = jwt.sign({
            notifications: result
        }, JWT_SECRET, {
            expiresIn: 60 * 60 * 24 * 7
        })

        res.send({status: true, result: encodedResult})
    }).catch((err) => {
        console.log(err)
        res.send({status: false, message: "Error retrieving notifications"})
    })
})

const updateNotifStatus = async (type, referenceID, notificationID, toUserID, fromUserID, notifHeadline, notifContent, actionlog) => {
    await UserNotifications.updateOne({ notificationID: notificationID }, { referenceStatus: true }).then(async (result) => {
        const awaitNotifID = await checkNotifID(`NTF_${makeID(20)}`)
        const notifParams = {
            notificationID: awaitNotifID,
            referenceID: referenceID,
            referenceStatus: true,
            toUserID: toUserID,
            fromUserID: fromUserID,
            content: {
                headline: notifHeadline,
                details: notifContent,
            },
            date: {
                date: dateGetter(),
                time: timeGetter()
            },
            type: type
        }
        sendNotification(notifParams, actionlog)
    }).catch((err) => {
        console.log(err)
        res.send({status: false, message: "Error encountered in notifications"})
    })
}

router.post('/declineContactRequest', jwtchecker, async (req, res) => {
    const userID = req.params.userID
    const token = req.body.token;

    try{
        const decodedToken = jwt.verify(token, JWT_SECRET)

        const type = decodedToken.type;
        const notificationID = decodedToken.notificationID;
        const referenceID = decodedToken.referenceID;
        const toUserID = decodedToken.toUserID;
        const fromUserID = decodedToken.fromUserID;

        await UserContacts.deleteOne({ contactID: referenceID }).then(async (result) => {
            res.send({status: true, message: "Contact has been deleted"})
            if(type == "contact_request"){
                const notifHeadline = `Declined Request`
                const notifContent = `${fromUserID} declined your request`
                
                await updateNotifStatus("info_contact_decline", referenceID, notificationID, toUserID, fromUserID, notifHeadline, notifContent, "You declined a contact request")
            }
        }).catch((err) => {
            console.log(err)
            res.send({status: false, message: "Error verifying decline request"})
        })
    }catch(ex){
        console.log(ex)
        res.send({status: false, message: "Error declining request"})
    }
})

router.post('/acceptContactRequest', jwtchecker, async (req, res) => {
    const userID = req.params.userID
    const token = req.body.token;

    try{
        const decodedToken = jwt.verify(token, JWT_SECRET)

        const type = decodedToken.type;
        const notificationID = decodedToken.notificationID;
        const referenceID = decodedToken.referenceID;
        const toUserID = decodedToken.toUserID;
        const fromUserID = decodedToken.fromUserID

        await UserContacts.updateOne({ contactID: referenceID }, { status: true }).then(async (result) => {
            res.send({status: true, message: "Contact has been accepted"})
            const notifHeadline = `Accepted Request`
            const notifContent = `${fromUserID} accepted your request`
                
            await updateNotifStatus("info_contact_accept", referenceID, notificationID, toUserID, fromUserID, notifHeadline, notifContent, "You accepted a contact request")
        }).catch((err) => {
            res.send({status: false, message: "Error verifying accept request"})
            console.log(err)
        })
        
    }catch(ex){
        console.log(ex)
        res.send({status: false, message: "Error accepting request"})
    }
})

router.get('/getContacts', jwtchecker, async (req, res) => {
    const userID = req.params.userID

    await UserContacts.aggregate([
        {
            $match:{
                $and:[
                    {
                        $or:[
                            { actionBy: userID },
                            { "users.userID": userID }
                        ]
                    },
                    {
                        status: true
                    }
                ]
            }
        },{
            $lookup:{
                from: "contacts",
                localField: "contactID",
                foreignField: "contactID",
                let: { 
                    firstUserID: { $arrayElemAt: ['$users.userID', 0] },
                    secondUserID: { $arrayElemAt: ['$users.userID', 1] } 
                },
                pipeline: [
                    {
                        $lookup:{
                            from: "useraccount",
                            pipeline:[
                                {
                                    $match: {
                                        $expr:{
                                            $and: [
                                                {$eq: ["$userID", "$$firstUserID"]},
                                                {$eq: ["$isVerified", true]},
                                                {$eq: ["$isActivated", true]}
                                            ]
                                        }
                                    }
                                }
                            ],
                            as: "userone"
                        }
                    },
                    {
                        $unwind:{
                            path: "$userone",
                            preserveNullAndEmptyArrays: true
                        }
                    },
                    {
                        $lookup:{
                            from: "useraccount",
                            pipeline:[
                                {
                                    $match: {
                                        $expr:{
                                            $and: [
                                                {$eq: ["$userID", "$$secondUserID"]},
                                                {$eq: ["$isVerified", true]},
                                                {$eq: ["$isActivated", true]}
                                            ]
                                        }
                                    }
                                }
                            ],
                            as: "usertwo"
                        }
                    },
                    {
                        $unwind:{
                            path: "$usertwo",
                            preserveNullAndEmptyArrays: true
                        }
                    }
                ],
                as: "userdetails"
            }
        },{
            $unwind:{
                path: "$userdetails",
                preserveNullAndEmptyArrays: true
            }
        },{
            $project:{
                "userdetails.actionBy": 0,
                "userdetails.actionDate": 0,
                "userdetails.contactID": 0,
                "userdetails.status": 0,
                "userdetails.users": 0,
                "users": 0,
                "userdetails.userone.birthdate": 0,
                "userdetails.userone.dateCreated": 0,
                "userdetails.userone.email": 0,
                "userdetails.userone.gender": 0,
                "userdetails.userone.isActivated": 0,
                "userdetails.userone.isVerified": 0,
                "userdetails.userone.password": 0,
                "userdetails.usertwo.birthdate": 0,
                "userdetails.usertwo.dateCreated": 0,
                "userdetails.usertwo.email": 0,
                "userdetails.usertwo.gender": 0,
                "userdetails.usertwo.isActivated": 0,
                "userdetails.usertwo.isVerified": 0,
                "userdetails.usertwo.password": 0
            }
        },{
            $sort: {_id: -1}
        }
    ]).then((result) => {
        // console.log(result)
        const encodedResult = jwt.sign({
            contacts: result
        }, JWT_SECRET, {
            expiresIn: 60 * 60 * 24 * 7
        })

        res.send({ status: true, result: encodedResult })

    }).catch((err) => {
        console.log(err)
        res.send({ status: false, message: "Error fetching contacts list" })
    })
})

const checkExistingMessageID = async (messageID) => {
    return await UserMessage.find({ messageID: messageID }).then((result) => {
        if(result.length > 0){
            checkExistingMessageID(makeID(30))
        }
        else{
            return messageID
        }
    }).catch((err) => {
        console.log(err)
        return false;
    })
}

const messagesTrigger = async (id, sseWithUserID, details) => {
    const userID = id;

    await UserMessage.aggregate([
        {
            $match:{
                receivers: { $in: [userID] }
            }
        },{
            $group: {
                _id: "$conversationID",
                sortID: { "$last": "$_id" },
                conversationID: { "$last": "$conversationID" },
                messageID: { "$last": "$messageID" },
                conversationID: { "$last": "$conversationID" },
                sender: { "$last": "$sender" },
                receivers: { "$last": "$receivers" },
                seeners: { "$last": "$seeners" },
                content: { "$last": "$content" },
                messageDate: { "$last": "$messageDate" },
                isReply: { "$last": "$isReply" },
                messageType: { "$last": "$messageType" },
                conversationType: { "$last": "$conversationType" }
            }
        },{
            $sort: {
                sortID: -1
            }
        },{
            $lookup:{
                from: "useraccount",
                localField: "receivers",
                foreignField: "userID",
                as: "users"
            }
        },{
            $project:{
                "users.birthdate": 0,
                "users.dateCreated": 0,
                "users.email": 0,
                "users.gender": 0,
                "users.isActivated": 0,
                "users.isVerified": 0,
                "users.password": 0
            }
        }
    ]).then((result) => {
        const encodedResult = jwt.sign({
            conversationslist: result
        }, JWT_SECRET, {
            expiresIn: 60 * 60 * 24 * 7
        })

        sseWithUserID.response.map((itr, i) => {
            itr.sse(`messages_list`, {
                status: true,
                auth: true,
                message: details,
                result: encodedResult
            })
        })
    }).catch((err) => {
        console.log(err)
        sseWithUserID.response.map((itr, i) => {
            itr.sse(`messages_list`, {
                status: false,
                auth: true,
                message: "Error generating conversations list"
            })
        })
    })
}

const sseMessageNotification = async (type, id, details) => {
    const sseWithUserID = sseNotificationsWaiters[id]

    if(sseWithUserID){
        if(type == "messages_list"){
            messagesTrigger(id, sseWithUserID, details)
        }
    }
}

router.post('/sendMessage', jwtchecker, async (req, res) => {
    const userID = req.params.userID;
    const token = req.body.token;

    try{
        const decodedToken = jwt.verify(token, JWT_SECRET)

        const messageID = await checkExistingMessageID(makeID(30));
        const conversationID = decodedToken.conversationID;
        const sender = userID;
        const receivers = decodedToken.receivers; //Array
        const seeners = decodedToken.seeners; //Array
        const content = decodedToken.content;
        const messageDate = {
            date: dateGetter(),
            time: timeGetter()
        };
        const isReply = decodedToken.isReply;
        const messageType = decodedToken.messageType;
        const conversationType = decodedToken.conversationType;

        const payload = {
            messageID: messageID,
            conversationID: conversationID,
            sender: sender,
            receivers: receivers,
            seeners: seeners,
            content: content,
            messageDate: messageDate,
            isReply: isReply,
            messageType: messageType,
            conversationType: conversationType
        }

        const newMessage = new UserMessage(payload)

        newMessage.save().then(() => {
            res.send({status: true, message: "Message Sent"})
            receivers.map((rcvs, i) => {
                sseMessageNotification("messages_list", rcvs, sender)
            })
        }).catch((err) => {
            console.log(err)
            res.send({status: false, message: "Error checking message"})
        })

    }catch(ex){
        console.log(ex)
        res.send({status: false, message: "Failed to send message"})
    }

})

router.get('/initConversationList', jwtchecker, async (req, res) => {
    const userID = req.params.userID;

    await UserMessage.aggregate([
        {
            $match:{
                receivers: { $in: [userID] }
            }
        },{
            $group: {
                _id: "$conversationID",
                sortID: { "$last": "$_id" },
                conversationID: { "$last": "$conversationID" },
                messageID: { "$last": "$messageID" },
                conversationID: { "$last": "$conversationID" },
                sender: { "$last": "$sender" },
                receivers: { "$last": "$receivers" },
                seeners: { "$last": "$seeners" },
                content: { "$last": "$content" },
                messageDate: { "$last": "$messageDate" },
                isReply: { "$last": "$isReply" },
                messageType: { "$last": "$messageType" },
                conversationType: { "$last": "$conversationType" }
            }
        },{
            $sort: {
                sortID: -1
            }
        },{
            $lookup:{
                from: "useraccount",
                localField: "receivers",
                foreignField: "userID",
                as: "users"
            }
        },{
            $project:{
                "users.birthdate": 0,
                "users.dateCreated": 0,
                "users.email": 0,
                "users.gender": 0,
                "users.isActivated": 0,
                "users.isVerified": 0,
                "users.password": 0
            }
        }
    ]).then((result) => {
        const encodedResult = jwt.sign({
            conversationslist: result
        }, JWT_SECRET, {
            expiresIn: 60 * 60 * 24 * 7
        })

        res.send({status: true, message: "OK", result: encodedResult})
    }).catch((err) => {
        console.log(err)
        res.send({status: false, message: "Error generating conversations list"})
    })
})

router.get('/initConversation/:conversationID', jwtchecker, async (req, res) => {
    const userID = req.params.userID;
    const conversationID = req.params.conversationID;

    await UserMessage.find({ conversationID: conversationID }).then((result) => {
        const encodedResult = jwt.sign({
            messages: result
        }, JWT_SECRET, {
            expiresIn: 60 * 60 * 24 * 7
        })

        res.send({ status: true, message: "OK", result: encodedResult })
    }).catch((err) => {
        console.log(err)
        res.send({ status: false, message: "Error generating conversation" })
    })
})

router.get('/sseNotifications/:token', [sse, jwtssechecker], (req, res) => {
    const userID = req.params.userID
    const sseWithUserID = sseNotificationsWaiters[userID]

    if(sseWithUserID){
        sseNotificationsWaiters[userID] = {
            response: [
                ...sseWithUserID.response,
                res
            ]
        }
    }
    else{
        sseNotificationsWaiters[userID] = {
            response: [
                res
            ]
        }
    }
})

router.get('/sselogout', jwtchecker, (req, res) => {
    
})

module.exports = router;
