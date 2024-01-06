const UserMessage = require('../../schema/messages/message')

const GetAllMessageCountInAConversation = async (conversationID) => {
    return await UserMessage.count({ conversationID: conversationID }).then((result) => {
        return result;
    })
}

module.exports = {
    GetAllMessageCountInAConversation
}