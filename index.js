const express = require("express");
const app = express();
const PORT = process.env.PORT || 3001;
const mysql = require("mysql");
const mongoose = require("mongoose");
const bodyParser = require("body-parser");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const path = require("path");
const nodemailer = require("nodemailer");
const socketIO = require("socket.io");

const MongooseConnection = require("./connections/index")

const Auth = require("./routes/auth/index")
const Messages = require("./routes/messages/index")
const Users = require("./routes/users/index");
const { initSocketIO } = require("./socketIO/socketIO");

const connectMongo = async () => {
    return mongoose.connect(MongooseConnection.url, MongooseConnection.params)
}

app.use(bodyParser.urlencoded({
    limit: "200mb",
    extended: false
}));
app.use(bodyParser.json({
    limit: "200mb"
}));
app.use(express.json());
app.use(cors({
    origin: "*",
    credentials: true,
    optionsSuccessStatus: 200
}))

app.use('/auth', Auth)
app.use('/m', Messages)
app.use('/u', Users)

app.get('/', (req, res) => {
    res.send("Welcome to ChatterLoop V2 API!")
})

const server = app.listen(PORT, () => {
    console.log(`Server Running: ${PORT}`)
    connectMongo().then(() => {
        console.log(`Connected to MongoDB`)
    }).catch((err) => {
        console.log(err)
    })
})

initSocketIO(server);