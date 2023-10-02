const socketIO = require("socket.io");

var callCollections = Object.create(null);

var io;

const initSocketIO = (server) => {
    io = new socketIO.Server(server, {
        cors:{
            origin: "*",
            methods: "*"
        }
    })

    io.on("connection", (socket) => {
        var socketID = socket.id;
        var conversationIDGlobal = [];
        
        socket.on("init", (data) => {
            var conversationID = data.conversationID;
            var currentCall = callCollections[conversationID];

            conversationIDGlobal.push(conversationID);

            if(currentCall){
                callCollections[conversationID] = {
                    users: [
                        ...currentCall.users,
                        {
                            socketID: socketID,
                            userID: data.userID
                        }
                    ]
                }
            }
            else{
                callCollections[conversationID] = {
                    users: [
                        {
                            socketID: socketID,
                            userID: data.userID
                        }
                    ]
                }
            }
            // console.log(socketID)
        })

        socket.on("data", (data) => {
            // console.log(socket.id, data);
            // socket.to
            // console.log(callCollections[data.conversationID].users)
        })

        socket.on("leavecall", (data) => {
            // console.log("LEAVE CALL", data);
            var conversationID = data.conversationID;
            var currentCall = callCollections[conversationID];
            var usersInCall = currentCall.users.filter((fl) => fl.socketID != socketID);

            callCollections[conversationID] = {
                users: [
                    ...usersInCall
                ]
            }

            console.log("LEAVE CALL", usersInCall)
        })
    
        socket.on("disconnect", (socket) => {
            conversationIDGlobal.map((gl) => {
                var currentCall = callCollections[gl];
                var usersInCall = currentCall.users.filter((fl) => fl.socketID != socketID);

                callCollections[gl] = {
                    users: [
                        ...usersInCall
                    ]
                }

                console.log("DISCONNECT CALL", usersInCall)
            })
        })

        socket.on("close", (socket) => {
            console.log("END SOCKET:", socket.id);
        })
    })
}

module.exports = {
    initSocketIO
}