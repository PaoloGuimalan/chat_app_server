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
            
            if(currentCall){
                var usersInCall = currentCall.users.filter((fl) => fl.socketID != socketID);

                if(usersInCall.length == 0){
                    delete callCollections[conversationID];

                    console.log("DELETE CALL IN MEMORY LEAVE CALL", usersInCall);
                }
                else{
                    callCollections[conversationID] = {
                        users: [
                            ...usersInCall
                        ]
                    }
    
                    console.log("LEAVE CALL", usersInCall)
                }
            }
            else{
                console.log("CALL ALREADY LEFT AND DELETED");
            }
        })
    
        socket.on("disconnect", (socket) => {
            conversationIDGlobal.map((gl) => {
                var currentCall = callCollections[gl];
                if(currentCall){
                    var usersInCall = currentCall.users.filter((fl) => fl.socketID != socketID);

                    if(usersInCall.length == 0){
                        delete callCollections[gl];

                        console.log("DELETE CALL IN MEMORY DISCONNECT", usersInCall);
                    }
                    else{
                        callCollections[gl] = {
                            users: [
                                ...usersInCall
                            ]
                        }
    
                        console.log("DISCONNECT CALL", usersInCall)
                    }
                }
                else{
                    console.log("CALL ALREADY DISCONNECTED AND DELETED");
                }
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