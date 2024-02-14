const UserMessage = require("../../schema/messages/message");
const UserContacts = require("../../schema/users/contacts");
const dateGetter = require("../hooks/getDate");
const timeGetter = require("../hooks/getTime");
const makeid = require("../hooks/makeID");
const { MessagesTrigger, ContactListTrigger } = require("../hooks/sse");

const checkExistingMessageID = async (messageID) => {
    return await UserMessage.find({ messageID: messageID }).then((result) => {
        if(result.length > 0){
            checkExistingMessageID(makeid(30))
        }
        else{
            return messageID
        }
    }).catch((err) => {
        console.log(err)
        return false;
    })
}

const GetMessageReceivers = async (conversationID, messageID) => {
    return await UserMessage.findOne({ conversationID: conversationID, messageID: messageID }).then((result) => {
        return result.receivers
    }).catch((err) => {
        console.log(err)
        throw new Error(err);
    })
}

const AddNewMemberToContacts = async (contactID, userID) => {
    return await UserContacts.updateMany({ contactID: contactID }, { $push: { users: { userID: userID } } }).then(() => {
        return true;
    }).catch((err) => {
        console.log(err);
        throw new Error(err);
    })
}

const AddNewMemberToAllMessages = async (conversationID, userID) => {
    return await UserMessage.updateMany({ conversationID: conversationID }, { $push: { receivers: userID } }).then(() => {
        return true;
    }).catch((err) => {
        console.log(err);
        throw new Error(err);
    })
}

const NotificationMessageForConversations = async (convID, userID, recs, details) => {
    const messageID = await checkExistingMessageID(makeid(30));
    const conversationID = convID;
    const sender = userID;
    const receivers = recs; //Array
    const seeners = []; //Array
    const content = details;
    const messageDate = {
        date: dateGetter(),
        time: timeGetter()
    };
    const isReply = false;
    const messageType = "notif";
    const conversationType = "group";

    const payload = {
        messageID: messageID,
        conversationID: conversationID,
        sender: sender,
        receivers: receivers,
        seeners: seeners,
        content: content,
        messageDate: messageDate,
        isReply: isReply,
        replyingTo: "",
        reactions: [],
        isDeleted: false,
        messageType: messageType,
        conversationType: conversationType
    }

    const newMessage = new UserMessage(payload)

    newMessage.save().then(() => {
        receivers.map((rcvs) => {
            MessagesTrigger(rcvs, sender, false)
            ContactListTrigger(rcvs, `${userID} added you on a group chat`)
        })
    }).catch((err) => {
        console.log(err)
    })
}

const GetAllReceivers = async (contactID) => {
    return await UserContacts.findOne({ contactID: contactID }).then((result) => {
        return result;
    }).catch((err) => {
        console.log(err);
        throw new Error(err);
    })
}

module.exports = {
    GetMessageReceivers,
    AddNewMemberToContacts,
    AddNewMemberToAllMessages,
    NotificationMessageForConversations,
    GetAllReceivers
}