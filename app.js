const express = require("express");
const bodyparser = require("body-parser");
const mysql = require("mysql");
const cors = require("cors");
const mongoose = require("mongoose");

const connection = require("./connection");

const Register = require("./schemas");
const Message = require("./schemas/messages");
const Contact = require("./schemas/contacts");
const Notifs = require("./schemas/notifications")

const app = express();
const port = process.env.PORT || 3001

app.use(bodyparser.urlencoded({ extended: false }));
app.use(bodyparser.json());

app.use(cors({
    origin:'*', 
    credentials:true,            //access-control-allow-credentials:true
    optionSuccessStatus:200,
 }));
app.use(express.json());

async function connectToMongoDB(){
    return mongoose.connect(connection.url, connection.params);
}

// const pool = mysql.createPool({
//     connectionLimit: 10,
//     host: "localhost" || '192.168.137.1',
//     user: "root",
//     password: "",
//     database: "chat_app"
// });

app.post('/userregister', (req, res) => {
    // pool.getConnection((err, connection) => {
    //     if(err) console.log(err);
    //     else console.log("Good!");

    //     connection.query('INSERT INTO user (username, email, password) VALUES (?,?,?)', 
    //     [req.body.username, req.body.email, req.body.password], (err, rows) => {
    //         connection.release();
    //         if(err) console.log(err);
    //     })
    // })

    const newRegister = new Register({
        username: req.body.username,
        email: req.body.email,
        password: req.body.password
    }, (err, result) => {
        if(err){
            
        }else{
            res.send([{prompt: "Register Successfull", registered: true}]);
        }
    });

    newRegister.save().then(() => res.send([{prompt: "Register Successfull", registered: true}])).catch((err) => res.send([{error: "Unable to Register!", registered: false}]));
})

app.post('/userlogin', (req, res) => {
    // pool.getConnection((err, connection) => {
    //     if(err) console.log(err);
    //     else console.log("Good!");

    //     connection.query('SELECT * FROM user WHERE email = ? AND password = ?', [req.body.email, req.body.password], (err, rows) => {
    //         connection.release();
    //         if(err) console.log(err);
    //         else res.send(rows); //console.log(rows);
    //     })
    // })
    // const id = mongoose.Types.ObjectId(req.body.email)
    Register.findOne({email: req.body.email, password: req.body.password},{username: true, email: true, password: true} , (err, results) => {
        // console.log(results);
        if(err){
            res.send([{error: "Unable to Log In!", logged: false}]);
        }else if(results){
            res.send([{...results._doc, message: "Logged In!" ,logged: true}]);
        }
        else{
            res.send([{error: "No Existing Account!", logged: false}]);
        };
    })
})

app.get('/messages/:username', (req, res) => {
    // pool.getConnection((err, connection) => {
    //     if(err) console.log(err);
    //     //else console.log("Okay!"); //console.log(req.params.username);

    //     connection.query("SELECT * FROM message_prompt WHERE message_id IN (SELECT MAX(message_id) FROM message_prompt WHERE conversation_id IN (SELECT conversation_id FROM message_prompt WHERE sent_to = ? GROUP BY conversation_id) GROUP BY conversation_id) ORDER BY message_id DESC;", req.params.username, 
    //     (err,rows) => {
    //         connection.release();
    //         if(err) console.log(err);
    //         else res.send(rows);
    //     })
    // })

    Message.aggregate([{$group: { _id: "$conversation_id",
    conversation_id: {
      $last: "$conversation_id"
    },
    message_id: {$last: "$message_id"},
    message: {$last: "$message"},
    who_sent: {$last: "$who_sent"},
    sent_to: {$last: "$sent_to"}}},{$match: {$or: [{who_sent: req.params.username}, {sent_to: req.params.username}]}}, {$sort: {message_id: -1}}], (err, result) => {
        res.send(result);
        // console.log(result);
    })
})

app.get('/conversation/:conid', async (req, res) => {
    const idconv = req.params.conid.split("&");
    const reverseid = idconv.reverse().join("");
    // pool.getConnection((err, connection) => {
    //     if(err) console.log(err);
    //     const idconv = req.params.conid.split("&");
    //     const reverseid = idconv.reverse().join("");
    //     //console.log(idconv);

    //     connection.query("SELECT * FROM message_prompt WHERE who_sent = ? AND sent_to = ? OR sent_to = ? AND who_sent = ?", [idconv[0], idconv[1], idconv[0], idconv[1]], 
    //     (err, rows) => {
    //         connection.release();
    //         if(err) console.log(err);
    //         else res.send(rows);
    //     })
    // })
    await Message.find({$and: [{$or: [{who_sent: idconv[0], sent_to: idconv[1]}, {$or: [{who_sent: idconv[1], sent_to: idconv[0]}]}]}]}, (err, result) => {
        if(err){
            console.log(err);
        }else{
            res.send(result);
        }
        // console.log(result);
    }).catch((err) => console.log)

})

app.post('/sendto', (req, res) => {
    // pool.getConnection((err, connection) => {
    //     if(err) console.log(err);

    //     connection.query("INSERT INTO message_prompt (conversation_id, message, who_sent, sent_to) VALUES (?,?,?,?)", [req.body.id, req.body.txt, req.body.from, req.body.to], 
    //     (err, rows) => {
    //         connection.release();
    //         if(err) console.log(err);
    //     })
    // })

    Message.count({}, async (err, results) => {
        // await console.log(results);
        const newMessage = await new Message({
            message_id: results + 1,
            conversation_id: req.body.id,
            message: req.body.txt,
            who_sent: req.body.from,
            sent_to: req.body.to,
            type: "conversation"
        })
    
        newMessage.save();
    })
})

app.post('/addcontact', (req, res) => {
    // pool.getConnection((err, connection) => {
    //     if(err) console.log(err);
    //     else console.log("Good!");

    //     connection.query('SELECT * FROM user WHERE username = ?', req.body.usern, (err, rows) => {
    //         connection.release();
    //         if(err) console.log(err);
    //         else{
    //             if(rows.length == 0){
    //                 res.send(`No User such ${req.body.usern} found.`);
    //             }
    //             else{
    //                 connection.query("INSERT INTO contacts (list_from, contact_username) VALUES (?,?)", [req.body.usern, req.body.user], 
    //                 (err2, rows2) => {
    //                     connection.release();
    //                     if(err2) console.log(err2);
    //                     else res.send(`${req.body.usern} has been added to your contacts.`)
    //                 })
    //             }
    //         } //console.log(rows);
    //     })
    // }

    Register.findOne({username: req.body.usern}, (err, result) => {
        if(result == null){
            res.send({message: `No User such ${req.body.usern} found.`, resp: false})
        }
        else{
            Contact.count({}, async (err, results) => {
                // console.log(results + 1);
                const newContact = await new Contact({
                    contact_id: results + 1,
                    list_from: req.body.usern,
                    contact_username: req.body.user,
                    status: 'pending'
                })
            
                newContact.save().then(res.send({message: `${req.body.usern} has been added to your contacts.`, resp: true})).catch((err) => console.log(err));
            })
        }
    })
})

app.post('/tonotif', (req, res) => {
    // pool.getConnection((err, connection) => {
    //     if(err) console.log(err);

    //     connection.query("INSERT INTO notifications (notif_description, notif_to, notif_date) VALUES (?,?,?)", [req.body.desco, req.body.usero, req.body.date], 
    //     (err, rows) => {
    //         connection.release();
    //         if(err) console.log(err);
    //         else{
    //             connection.query("INSERT INTO notifications (notif_description, notif_to, notif_date) VALUES (?,?,?)", [req.body.desct, req.body.usert, req.body.date], 
    //             (err2, rows2) => {
    //                 connection.release();
    //                 if(err2) console.log(err2);
    //                 else console.log("Notif Added!");
    //             })
    //         };
    //     })
    // })

    Notifs.count({}, async (err, result) => {
        if(err){
            console.log(err);
        }
        else{

            var today = await new Date();
            var dd = await String(today.getDate()).padStart(2, '0');
            var mm = await String(today.getMonth() + 1).padStart(2, '0'); //January is 0!
            var yyyy = await today.getFullYear();

            var today_fixed = await mm + '/' + dd + '/' + yyyy;

            const newNotifs = await new Notifs({
                notif_id: result + 1,
                notif_description: req.body.desco,
                notif_to: req.body.usero,
                notif_from: req.body.usert,
                notif_date: today_fixed,
                notif_type: "contact_sender",
                notif_status: false
            })

            newNotifs.save().then(async() => {
                const secNewNotifs = await new Notifs({
                    notif_id: result + 2,
                    notif_description: req.body.desct,
                    notif_to: req.body.usert,
                    notif_from: req.body.usero,
                    notif_date: today_fixed,
                    notif_type: "contact_receiver",
                    notif_status: false
                })
                secNewNotifs.save();
            }).catch((err) => console.log);;
        }
    })
})

app.get('/contact/:userna', (req, res) => {
    // pool.getConnection((err, connection) => {
    //     if(err) console.log(err);

    //     connection.query("SELECT * FROM contacts WHERE contact_username = ?", req.params.userna, 
    //     (err, rows) => {
    //         connection.release();
    //         if(err) console.log(err);
    //         else res.send(rows);
    //     })
    // })

    Contact.find({contact_username: req.params.userna}, (err, result) => {
        res.send(result);
    })
})

app.get('/notifications/:iduse', (req, res) => {
    // pool.getConnection((err, connection) => {
    //     if(err) console.log(err);

    //     connection.query("SELECT * FROM notifications WHERE notif_to = ? ORDER BY notif_id DESC", req.params.iduse, 
    //     (err, rows) => {
    //         connection.release();
    //         if(err) console.log(err);
    //         else res.send(rows);
    //     })
    // })

    Notifs.find({notif_to: req.params.iduse}, null, {sort: {notif_id: -1}}, (err, result) => {
        if(err){
            console.log(err)
        }
        else{
            res.send(result);
        }
    })
})

app.get('/getallconvo/:username', (req, res) => {
    Message.count({sent_to: req.params.username}, (err, result) => {
        if(err){
            console.log(err);
        }
        else{
            res.send([{convoCount: result}]);
        }
    })
})

app.post('/accept_req', (req, res) => {
    const id = req.body.notif_id;
    const usersend = req.body.release_from;
    const userrec = req.body.release_to;
    const conv = `${usersend}&${userrec}`;

    Notifs.updateOne({notif_id: id}, {$set: {notif_status: true}}, async (err) => {
        if(err){
            console.log(err);
        }
    }).clone().catch(err => console.log(err));

    Contact.updateOne({list_from: usersend, contact_username: userrec}, {$set: {status: "connected"}}, (err) => {
        if(err){
            console.log(err);
        }
    }).clone().then(() => {
        Contact.count({}, async (err, results) => {
            // console.log(results + 1);
            const confContact = await new Contact({
                contact_id: results + 1,
                list_from: userrec,
                contact_username: usersend,
                status: 'connected'
            })
        
            confContact.save().then(() => {
                Notifs.count({}, async (err, result) => {
                    if(err){
                        console.log(err);
                    }
                    else{

                        var today = await new Date();
                        var dd = await String(today.getDate()).padStart(2, '0');
                        var mm = await String(today.getMonth() + 1).padStart(2, '0'); //January is 0!
                        var yyyy = await today.getFullYear();

                        var today_fixed = await mm + '/' + dd + '/' + yyyy;

                        const confNotifs = new Notifs({
                            notif_id: result + 1,
                            notif_description: `${usersend} has accepted your request!`,
                            notif_to: userrec,
                            notif_from: usersend,
                            notif_date: today_fixed,
                            notif_type: "acceptance_notif",
                            notif_status: false
                        })

                        confNotifs.save(async () => {
                            Message.count({}, async (err, results) => {
                                // await console.log(results);
                                const newMessage = await new Message({
                                    message_id: results + 1,
                                    conversation_id: conv,
                                    message: `${userrec} requested connection.`,
                                    who_sent: userrec,
                                    sent_to: usersend,
                                    type: "initiator"
                                })
                            
                                await newMessage.save().catch((err) => console.log(err));;

                                const new2Message = await new Message({
                                    message_id: results + 2,
                                    conversation_id: conv,
                                    message: `${usersend} is now connected.`,
                                    who_sent: usersend,
                                    sent_to: userrec,
                                    type: "initiator"
                                })
                            
                                await new2Message.save().catch((err) => console.log(err));;
                            }).clone().catch(err => console.log(err));
                        })
                    }
                }).clone().catch(err => console.log(err));
            })
        }).clone().catch(err => console.log(err));
    }).catch(err => console.log(err));

})


connectToMongoDB()
    .then(app.listen(port, () => console.log(`Port ongoing! Port: ${port}`)))
    .catch(err => console.log(err));