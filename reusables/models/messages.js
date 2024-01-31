const UserMessage = require("../../schema/messages/message");

const GetMessageReceivers = async (conversationID, messageID) => {
    return await UserMessage.findOne({ conversationID: conversationID, messageID: messageID }).then((result) => {
        return result.receivers
    }).catch((err) => {
        console.log(err)
    })
}

module.exports = {
    GetMessageReceivers
}