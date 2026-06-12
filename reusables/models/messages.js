const UserMessage = require("../../schema/messages/message");
const UserContacts = require("../../schema/users/contacts");
const dateGetter = require("../hooks/getDate");
const timeGetter = require("../hooks/getTime");
const makeid = require("../hooks/makeID");
const { MessagesTrigger, ContactListTrigger } = require("../hooks/sse");
const producer = require("../rabbitmq/producer");
const {
  MESSAGES_TRIGGER_LOOPER,
  CONTACT_LIST_TRIGGER_LOOPER,
} = require("../vars/rabbitmqevents");
const { publish } = require("../redis/pubsub");
const pool = require("../../reusables/database/postgres");
const { v4: uuidv4 } = require("uuid");

const checkExistingMessageID = async (messageID) => {
  return await UserMessage.find({ messageID: messageID })
    .then((result) => {
      if (result.length > 0) {
        checkExistingMessageID(makeid(30));
      } else {
        return messageID;
      }
    })
    .catch((err) => {
      console.log(err);
      return false;
    });
};

const GetMessageReceivers = async (conversationID, messageID) => {
  return await UserMessage.findOne({
    conversationID: conversationID,
    messageID: messageID,
  })
    .then((result) => {
      return result.receivers;
    })
    .catch((err) => {
      console.log(err);
      throw new Error(err);
    });
};

const AddNewMemberToContacts = async (
  contactID,
  userID,
  added_by_id = null,
) => {
  const member_id = uuidv4(); // generate a unique UUID for member_id
  const date_joined = new Date(); // current timestamp

  const query = `
    INSERT INTO community_member
    (member_id, account_id, nickname, realm_id, added_by_id, date_joined, role)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (account_id, realm_id) DO NOTHING;
  `;

  const params = [
    member_id,
    userID,
    null,
    contactID,
    added_by_id,
    date_joined,
    "member",
  ];

  try {
    await pool.query(query, params);
    return true;
  } catch (err) {
    console.error("Failed to add new member:", err);
    throw err;
  }
};

const AddNewMemberToAllMessages = async (conversationID, userID) => {
  // return await UserMessage.updateMany(
  //   { conversationID: conversationID },
  //   { $push: { receivers: userID } },
  // )
  //   .then(() => {
  //     return true;
  //   })
  //   .catch((err) => {
  //     console.log(err);
  //     throw new Error(err);
  //   });

  return true;
};

const NotificationMessageForConversations = async (
  convID,
  userID,
  recs,
  details,
  convType,
) => {
  const messageID = await checkExistingMessageID(makeid(30));
  const conversationID = convID;
  const sender = userID;
  const receivers = recs; //Array
  const seeners = []; //Array
  const content = details;
  // const messageDate = {
  //   date: dateGetter(),
  //   time: timeGetter(),
  // };
  const isReply = false;
  const messageType = "notif";
  const conversationType = convType;

  const payload = {
    messageID: messageID,
    conversationID: conversationID,
    sender: sender,
    receivers: receivers,
    seeners: seeners,
    content: content,
    // messageDate: messageDate,
    isReply: isReply,
    replyingTo: "",
    reactions: [],
    isDeleted: false,
    messageType: messageType,
    conversationType: conversationType,
  };

  const newMessage = new UserMessage(payload);

  newMessage
    .save()
    .then(async () => {
      receivers.map((rcvs) => {
        MessagesTrigger(rcvs, { conversationID, userID: sender }, false);
        ContactListTrigger(rcvs, `${userID} added you on a group chat`);
        // publish(`events_${rcvs}`, MESSAGES_TRIGGER_LOOPER, {
        //   parameters: {
        //     receivers: receivers,
        //     sender: sender,
        //     onseen: false,
        //   },
        // });
        // publish(`events_${rcvs}`, CONTACT_LIST_TRIGGER_LOOPER, {
        //   parameters: {
        //     receivers: receivers,
        //     details: `${userID} added you on a group chat`,
        //   },
        // });
      });
      //   await producer.publishMessage(
      //     "INFO:CHATTERLOOP",
      //     MESSAGES_TRIGGER_LOOPER,
      //     {
      //       parameters: {
      //         receivers: receivers,
      //         sender: sender,
      //         onseen: false,
      //       },
      //     }
      //   );
      //   await producer.publishMessage(
      //     "INFO:CHATTERLOOP",
      //     CONTACT_LIST_TRIGGER_LOOPER,
      //     {
      //       parameters: {
      //         receivers: receivers,
      //         details: `${userID} added you on a group chat`,
      //       },
      //     }
      //   );
    })
    .catch((err) => {
      console.log(err);
    });
};

const GetAllReceivers = async (contactID) => {
  const { rows: rows_connections } = await pool.query(
    "SELECT ua.id, ua.username FROM user_connection uc JOIN user_account ua ON ua.id = uc.involved_user_id WHERE uc.connection_id = $1;",
    [contactID],
  );

  if (rows_connections.length > 0) {
    return {
      users: rows_connections.map((mp) => ({
        userID: mp.id,
        username: mp.username,
      })),
    };
  }

  const { rows: rows_members } = await pool.query(
    "SELECT ua.id, ua.username FROM community_member uc JOIN user_account ua ON ua.id = uc.account_id WHERE uc.realm_id = $1;",
    [contactID],
  );

  if (rows_members.length > 0) {
    return {
      users: rows_members.map((mp) => ({
        userID: mp.id,
        username: mp.username,
      })),
    };
  }

  return { users: [] };
};

const AddNewMemberToChannels = async (
  userIDProp,
  username,
  tokenProp,
  type,
) => {
  const token = tokenProp;
  const userID = userIDProp;

  try {
    const decodedToken = token;
    const conversationID = decodedToken.conversationID;
    const memberstoadd = decodedToken.memberstoadd;
    const receiversfetch = await GetAllReceivers(conversationID);
    const receivers = [
      ...decodedToken.receivers,
      ...receiversfetch.users.map((mp) => mp.userID),
    ];

    memberstoadd.map((mp) => {
      AddNewMemberToContacts(conversationID, mp.id, userID)
        .then(() => {
          if (type !== "server" && type !== "voice" && type !== "page") {
            AddNewMemberToAllMessages(conversationID, mp.userID)
              .then(() => {
                NotificationMessageForConversations(
                  conversationID,
                  userID,
                  receivers,
                  userID === mp.userID
                    ? `${mp.userID} joined`
                    : `${username} added ${mp.userID}`,
                  "server",
                );
              })
              .catch((err) => console.log);
          }
        })
        .catch((err) => console.log);
    });

    // console.log(userID, decodedToken.conversationID, decodedToken.memberstoadd);

    // res.send({ status: true, message: "OK" })
  } catch (ex) {
    console.log(ex);
    // res.send({ status: false, message: "Error decoding token" })
  }
};

const GetRealmsJoined = async (userID) => {
  const { rows } = await pool.query(
    `
    SELECT DISTINCT r.realm_id
    FROM community_member cm
    JOIN community_realm r ON cm.realm_id = r.realm_id
    WHERE cm.account_id = $1
      AND r.type IN ('group', 'server');
  `,
    [userID],
  );

  return rows.map((r) => r.realm_id);
};

module.exports = {
  GetMessageReceivers,
  AddNewMemberToContacts,
  AddNewMemberToAllMessages,
  NotificationMessageForConversations,
  GetAllReceivers,
  AddNewMemberToChannels,
  GetRealmsJoined,
};
