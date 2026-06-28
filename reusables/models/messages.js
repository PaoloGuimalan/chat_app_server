const UserMessage = require("../../schema/messages/message");
const UserContacts = require("../../schema/users/contacts");
const ChatHistory = require("../../schema/messages/chathistory");
const Conversation = require("../../schema/messages/conversation");
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
const {
  expandMemberTargets,
  userIDsToEntityIDs,
  getRealmIDsViaActingEntities,
  buildUserEntityID,
  resolveUserEntity,
} = require("./entities");

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

const normalizeConversationType = (conversationType = "single") => {
  if (!conversationType) {
    return "single";
  }

  const parsedType = String(conversationType).toLowerCase();
  return parsedType === "server" ? "channel" : parsedType;
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

  const userEntity = await resolveUserEntity(userID).catch(() => null);
  if (!userEntity?.id) {
    throw new Error("Entity profile not found for user");
  }
  const addedByEntity =
    added_by_id && added_by_id !== userID
      ? await resolveUserEntity(added_by_id).catch(() => null)
      : userEntity;

  const query = `
    INSERT INTO community_member
    (member_id, account_id, nickname, realm_id, added_by_id, date_joined, role)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (account_id, realm_id) DO NOTHING;
  `;

  const params = [
    member_id,
    userEntity.id,
    null,
    contactID,
    addedByEntity?.id || userEntity.id,
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

const SaveConversation = (
  conversationID,
  conversationType = "single",
  senderType = "user",
  authorRealm = null,
  participant_ids = [],
  messageID = null,
  sender = null,
  text = "",
  messageDate = new Date(),
  messageType = "text",
  isDeleted = false,
  senderEntityID = null,
  participant_entity_ids = [],
) => {
  if (!conversationID) {
    return Promise.reject(new Error("conversationID is required"));
  }

  const normalizedPayload = {
    conversationID,
    conversationType: normalizeConversationType(conversationType),
    senderType,
    authorRealm,
    senderEntityID,
    participant_ids: [...new Set((participant_ids || []).filter(Boolean))],
    participant_entity_ids: [
      ...new Set((participant_entity_ids || []).filter(Boolean)),
    ],
    last_message: {
      messageID,
      sender,
      text,
      messageDate: messageDate ? new Date(messageDate) : new Date(),
      messageType,
      isDeleted: isDeleted === true,
    },
  };

  return Conversation.findOne({ conversationID }).then(
    (existingConversation) => {
      if (existingConversation) {
        existingConversation.conversationType =
          normalizedPayload.conversationType;
        existingConversation.senderType = normalizedPayload.senderType;
        existingConversation.authorRealm = normalizedPayload.authorRealm;
        existingConversation.senderEntityID = normalizedPayload.senderEntityID;
        existingConversation.last_message = normalizedPayload.last_message;

        existingConversation.participant_ids = normalizedPayload.participant_ids;
        existingConversation.markModified("participant_ids");

        existingConversation.participant_entity_ids =
          normalizedPayload.participant_entity_ids;
        existingConversation.markModified("participant_entity_ids");

        return existingConversation.save();
      }

      const newConversation = new Conversation(normalizedPayload);
      return newConversation.save();
    },
  );
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
  const receiversfetch = await GetAllReceivers(conversationID);
  const receivers = [
    ...new Set([
      ...(Array.isArray(recs) ? recs : []),
      ...receiversfetch.users.map((mp) => mp.userID),
    ]),
  ]; //Array
  const seeners = []; //Array
  const content = details;
  // const messageDate = {
  //   date: dateGetter(),
  //   time: timeGetter(),
  // };
  const isReply = false;
  const messageType = "notif";
  const conversationType = normalizeConversationType(convType);

  const payload = {
    messageID: messageID,
    conversationID: conversationID,
    sender: sender,
    receivers: receivers,
    receiverEntityIDs:
      receiversfetch.entities?.length > 0
        ? receiversfetch.entities
        : userIDsToEntityIDs(receivers),
    seeners: seeners,
    seenerEntityIDs: [buildUserEntityID(userID)],
    content: content,
    // messageDate: messageDate,
    isReply: isReply,
    replyingTo: "",
    reactions: [],
    isDeleted: false,
    messageType: messageType,
    conversationType: conversationType,
    actorUserID: userID,
    senderEntityID: buildUserEntityID(userID),
    senderType: "user",
    authorRealm: null,
  };

  const newMessage = new UserMessage(payload);

  newMessage
    .save()
    .then(async () => {
      await ChatHistory.updateMany(
        {
          conversationID: conversationID,
        },
        {
          $set: {
            isArchived: false,
          },
        },
      );

      await SaveConversation(
        conversationID,
        conversationType,
        "user",
        null,
        receivers,
        messageID,
        sender,
        content,
        new Date(),
        messageType,
        false,
        buildUserEntityID(userID),
        receiversfetch.entities?.length
          ? receiversfetch.entities
          : userIDsToEntityIDs(receivers),
      );

      receivers.map((rcvs) => {
        MessagesTrigger(rcvs, { conversationID, userID: sender }, false);
        ContactListTrigger(rcvs, `${userID} added you on a group chat`);
      });
    })
    .catch((err) => {
      console.log(err);
    });
};

const SyncConversationLastMessage = async (conversationID) => {
  if (!conversationID) throw new Error("conversationID is required");

  const convo = await Conversation.findOne({ conversationID }).lean();
  const currentLastMessageID = convo?.last_message?.messageID;
  if (!currentLastMessageID) return null;

  const msg = await UserMessage.findOne({
    conversationID,
    messageID: currentLastMessageID,
  }).lean();
  if (!msg) return null;

  return Conversation.findOneAndUpdate(
    { conversationID },
    {
      $set: {
        last_message: {
          messageID: msg.messageID ?? null,
          sender: msg.sender ?? null,
          text: msg.content ?? "",
          messageDate: msg.messageDate ?? new Date(),
          messageType: msg.messageType ?? "text",
          isDeleted: msg.isDeleted === true,
          seeners: msg.seeners,
        },
        conversationType:
          msg.conversationType ?? convo?.conversationType ?? "single",
        senderType: msg.senderType ?? convo?.senderType ?? "user",
        authorRealm: msg.authorRealm ?? convo?.authorRealm ?? null,
        senderEntityID: msg.senderEntityID ?? convo?.senderEntityID ?? null,
      },
    },
    { new: true },
  );
};

const SyncConversationParticipants = async (conversationID) => {
  if (!conversationID) {
    throw new Error("conversationID is required");
  }

  const existingConversation = await Conversation.findOne({
    conversationID,
  });

  if (!existingConversation) {
    return null;
  }

  const receiversfetch = await GetAllReceivers(conversationID);
  const participantIDs = [
    ...new Set(
      receiversfetch.users
        .map((member) => member.userID)
        .filter((memberID) => memberID),
    ),
  ];

  existingConversation.participant_ids = participantIDs;
  existingConversation.participant_entity_ids =
    receiversfetch.entities?.length > 0
      ? [...new Set(receiversfetch.entities.filter(Boolean))]
      : userIDsToEntityIDs(participantIDs);
  existingConversation.markModified("participant_ids");
  existingConversation.markModified("participant_entity_ids");
  return await existingConversation.save();
};

const GetAllReceivers = async (contactID) => {
  const { rows: rows_connections } = await pool.query(
    "SELECT ua.id, ua.username FROM user_connection uc JOIN user_account ua ON ua.id = uc.involved_user_id WHERE uc.connection_id = $1;",
    [contactID],
  );

  if (rows_connections.length > 0) {
    const users = rows_connections.map((mp) => ({
      userID: mp.id,
      username: mp.username,
      entityID: buildUserEntityID(mp.id),
      joinedAsEntityID: null,
    }));
    return {
      users,
      entities: [...new Set(users.map((member) => member.entityID))],
    };
  }

  const { rows: rows_members } = await pool.query(
    `
      SELECT ua.id, ua.username
      FROM community_member uc
      LEFT JOIN entity account_entity
        ON account_entity.id = uc.account_id
       AND account_entity.entity_type = 'user'
      JOIN user_account ua
        ON ua.id = COALESCE(account_entity.source_id, uc.account_id)
      WHERE uc.realm_id = $1;
    `,
    [contactID],
  );

  const { rows: realm_entity_members } = await pool.query(
    `
      SELECT DISTINCT nickname AS entity_id
      FROM community_member
      WHERE realm_id = $1
        AND nickname IS NOT NULL
        AND nickname LIKE 'entity:%';
    `,
    [contactID],
  );

  if (rows_members.length > 0 || realm_entity_members.length > 0) {
    const membersMap = new Map();
    const participantEntities = new Set();

    rows_members.forEach((member) => {
      const entityID = buildUserEntityID(member.id);
      participantEntities.add(entityID);
      membersMap.set(String(member.id), {
        userID: member.id,
        username: member.username,
        entityID,
        joinedAsEntityID: null,
      });
    });

    const expandedEntityMembers = await expandMemberTargets({
      memberEntityIDs: realm_entity_members.map((member) => member.entity_id),
    });

    const missingUserIDs = expandedEntityMembers
      .map((member) => member.userID)
      .filter(Boolean)
      .filter((userID) => !membersMap.has(String(userID)));

    if (missingUserIDs.length > 0) {
      const { rows: missingUsers } = await pool.query(
        `SELECT id, username FROM user_account WHERE id = ANY($1);`,
        [[...new Set(missingUserIDs)]],
      );

      missingUsers.forEach((user) => {
        const entityID = buildUserEntityID(user.id);
        participantEntities.add(entityID);
        membersMap.set(String(user.id), {
          userID: user.id,
          username: user.username,
          entityID,
          joinedAsEntityID: null,
        });
      });
    }

    expandedEntityMembers.forEach((member) => {
      if (member.joinedAsEntityID) {
        participantEntities.add(member.joinedAsEntityID);
      }
    });

    return {
      users: Array.from(membersMap.values()),
      entities: [...participantEntities],
    };
  }

  const conversation = await Conversation.findOne({
    conversationID: contactID,
  }).lean();

  const participantIDs = [
    ...new Set((conversation?.participant_ids || []).filter(Boolean)),
  ];

  if (participantIDs.length > 0) {
    const { rows } = await pool.query(
      `SELECT id, username FROM user_account WHERE id = ANY($1);`,
      [participantIDs],
    );

    if (rows.length > 0) {
      const users = rows.map((member) => ({
        userID: member.id,
        username: member.username,
        entityID: buildUserEntityID(member.id),
        joinedAsEntityID: null,
      }));
      return {
        users,
        entities: [...new Set(users.map((member) => member.entityID))],
      };
    }
  }

  const participantEntityIDs = [
    ...new Set((conversation?.participant_entity_ids || []).filter(Boolean)),
  ];

  if (participantEntityIDs.length > 0) {
    const expandedMembers = await expandMemberTargets({
      memberEntityIDs: participantEntityIDs,
    });
    const expandedUserIDs = [
      ...new Set(expandedMembers.map((member) => member.userID).filter(Boolean)),
    ];

    if (expandedUserIDs.length > 0) {
      const { rows } = await pool.query(
        `SELECT id, username FROM user_account WHERE id = ANY($1);`,
        [expandedUserIDs],
      );

      if (rows.length > 0) {
        const users = rows.map((member) => ({
          userID: member.id,
          username: member.username,
          entityID: buildUserEntityID(member.id),
          joinedAsEntityID: null,
        }));
        const entitySet = new Set(
          participantEntityIDs.filter((entityID) => entityID),
        );
        users.forEach((member) => entitySet.add(member.entityID));

        return {
          users,
          entities: [...entitySet],
        };
      }
    }
  }

  return { users: [], entities: [] };
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
                  type,
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
  const userEntity = await resolveUserEntity(userID);
  if (!userEntity?.id) {
    return [];
  }
  const { rows } = await pool.query(
    `
    SELECT DISTINCT r.realm_id
    FROM community_member cm
    JOIN community_realm r ON cm.realm_id = r.realm_id
    WHERE cm.account_id = ANY($1::text[])
      AND r.type IN ('group', 'server', 'channel');
  `,
    [[String(userEntity.id)]],
  );

  const joinedViaEntities = await getRealmIDsViaActingEntities(userID);

  return [
    ...new Set([
      ...rows.map((realm) => realm.realm_id),
      ...joinedViaEntities.filter(Boolean),
    ]),
  ];
};

module.exports = {
  GetMessageReceivers,
  AddNewMemberToContacts,
  AddNewMemberToAllMessages,
  NotificationMessageForConversations,
  GetAllReceivers,
  AddNewMemberToChannels,
  GetRealmsJoined,
  SaveConversation,
  SyncConversationLastMessage,
  SyncConversationParticipants,
  normalizeConversationType,
};
