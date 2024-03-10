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
                var newCallMembersSet = [
                    ...currentCall.users,
                    {
                        socketID: socketID,
                        userID: data.userID,
                        offererUserName: data.userID,
                        offer: null,
                        offerIceCandidates: [],
                        answererUserName: null,
                        answer: null,
                        answererIceCandidates: []
                    }
                ]

                callCollections[conversationID] = {
                    users: newCallMembersSet
                }

                var usersInCallSocketMemory = callCollections[conversationID].users.map((mp) => mp.userID);
                io.to(socketID).emit('caller_connected', usersInCallSocketMemory);

                newCallMembersSet.filter((flt) => flt.socketID !== socketID).map((mp) => {
                    var usersInCallSocketMemory = callCollections[conversationID].users.map((mp) => mp.userID);
                    io.to(mp.socketID).emit('newCaller', usersInCallSocketMemory);
                })
            }
            else{
                var newCallMembersSet = [
                    {
                        socketID: socketID,
                        userID: data.userID,
                        offererUserName: data.userID,
                        offer: null,
                        offerIceCandidates: [],
                        answererUserName: null,
                        answer: null,
                        answererIceCandidates: []
                    }
                ]

                callCollections[conversationID] = {
                    users: newCallMembersSet
                }

                callCollections[conversationID] = {
                    users: newCallMembersSet
                }

                var usersInCallSocketMemory = callCollections[conversationID].users.map((mp) => mp.userID);
                io.to(socketID).emit('caller_connected', usersInCallSocketMemory);

                newCallMembersSet.filter((flt) => flt.socketID !== socketID).map((mp) => {
                    var usersInCallSocketMemory = callCollections[conversationID].users.map((mp) => mp.userID);
                    io.to(mp.socketID).emit('newCaller', usersInCallSocketMemory);
                })
            }
            console.log(socketID, conversationIDGlobal, data)
        })

        socket.on("newOffer", (data) => {
            var conversationID = data.conversationID;
            var currentCall = callCollections[conversationID];

            if(currentCall){
                const myOffer = currentCall.users.filter((flt) => flt.socketID === socketID)[0];
                const otherOffers = currentCall.users.filter((flt) => flt.socketID !== socketID);

                var newCallMembersSet = [
                    ...otherOffers,
                    {
                        ...myOffer,
                        offer: data.offer
                    }
                ]

                callCollections[conversationID] = {
                    users: newCallMembersSet
                }

                // console.log(newCallMembersSet)

                currentCall.users.filter((flt) => flt.socketID !== socketID).map((mp) => {
                    // var usersInCallSocketMemory = callCollections[conversationID].users.map((mp) => mp.userID);
                    const peerdata = data
                    io.to(mp.socketID).emit('newOfferAwaiting', peerdata);
                })
            }
        })

        socket.on("data", (data) => {
            var conversationID = data.conversationID;
            var currentCall = callCollections[conversationID];

            if(currentCall){
                currentCall.users.filter((flt) => flt.socketID !== socketID).map((mp) => {
                    // var usersInCallSocketMemory = callCollections[conversationID].users.map((mp) => mp.userID);
                    const peerdata = data
                    io.to(mp.socketID).emit('connect_peer_service', peerdata);
                })
            }

            // console.log(socket.id, data);
            // socket.to
            // console.log(callCollections[data.conversationID].users)
        })

        socket.on("sendIceCandidateToSignalingServer", (data) => {
            var conversationID = data.conversationID;
            var currentCall = callCollections[conversationID];

            if(data.didIOffer){
                // console.log("I OFFER")
                const offerInOffers = currentCall.users.filter((flt) => flt.offererUserName === data.iceUserName)[0];
                if(offerInOffers){
                    offerInOffers.offerIceCandidates.push(data.iceCandidate);
                    if(offerInOffers.answererUserName){
                        const socketToSendTo = currentCall.users.filter((flt) => flt.userID === offerInOffers.answererUserName)[0]
                        if(socketToSendTo){
                            io.to(socketToSendTo.socketID).emit('receivedIceCandidateFromServer', data.iceCandidate)
                        }else{
                            console.log("Ice candidate recieved but could not find answere")
                        }
                    }
                }
            }
            else{
                // console.log("NO OFFER")
                const offerInOffers = currentCall.users.filter((flt) => flt.answererUserName === data.iceUserName)[0];
                const socketToSendTo = currentCall.users.filter((flt) => flt.userID === offerInOffers.offererUserName)[0];
                if(socketToSendTo){
                    socket.to(socketToSendTo.socketID).emit('receivedIceCandidateFromServer', data.iceCandidate)
                }else{
                    console.log("Ice candidate recieved but could not find offerer")
                }
            }
        })

        socket.on("newAnswer", (data, ackFunction) => {
            var conversationID = data.conversationID;
            var currentCall = callCollections[conversationID];

            if(currentCall){
                const socketToAnswer = currentCall.users.filter((flt) => flt.userID === data.userID)[0]

                if(socketToAnswer){
                    const socketIdToAnswer = socketToAnswer.socketID
                    const offerToUpdate = currentCall.users.filter((flt) => flt.userID === data.userID)[0]

                    if(!offerToUpdate){
                        console.log("No OfferToUpdate")
                        return;
                    }

                    ackFunction(offerToUpdate.offerIceCandidates);
                    // console.log(offerToUpdate.offerIceCandidates)
                    offerToUpdate.answer = data.answer
                    offerToUpdate.answererUserName = data.userName

                    // console.log(socketToAnswer);

                    io.to(socketIdToAnswer).emit('answerResponse', offerToUpdate)
                }
            }
        })

        socket.on("answer_data", (data) => {
            var conversationID = data.conversationID;
            var currentCall = callCollections[conversationID];

            if(currentCall){
                currentCall.users.filter((flt) => flt.socketID !== socketID).map((mp) => {
                    // var usersInCallSocketMemory = callCollections[conversationID].users.map((mp) => mp.userID);
                    const peerdata = data
                    io.to(mp.socketID).emit('answer_peer_service', peerdata);
                })
            }

            // console.log(socket.id, data);
            // socket.to
            // console.log(callCollections[data.conversationID].users)
        })

        socket.on("answer_negotiation_data", (data) => {
            var conversationID = data.conversationID;
            var currentCall = callCollections[conversationID];

            if(currentCall){
                currentCall.users.filter((flt) => flt.socketID !== socketID).map((mp) => {
                    // var usersInCallSocketMemory = callCollections[conversationID].users.map((mp) => mp.userID);
                    const peerdata = data
                    io.to(mp.socketID).emit('push_negotiation_data', peerdata);
                })
            }

            // console.log(socket.id, data);
            // socket.to
            // console.log(callCollections[data.conversationID].users)
        })

        socket.on("finish_negotiation_data", (data) => {
            var conversationID = data.conversationID;
            var currentCall = callCollections[conversationID];

            if(currentCall){
                currentCall.users.filter((flt) => flt.socketID !== socketID).map((mp) => {
                    // var usersInCallSocketMemory = callCollections[conversationID].users.map((mp) => mp.userID);
                    const peerdata = data
                    io.to(mp.socketID).emit('push_finish_negotiation_data', peerdata);
                })
            }

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