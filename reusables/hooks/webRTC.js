require("dotenv").config();
const mediasoup = require("mediasoup");
const { publish, removeParticipant } = require("../redis/pubsub");

let worker;
let rooms = new Map();

(async () => {
  worker = await mediasoup.createWorker({
    logLevel: "warn",
    rtcMinPort: 10000,
    rtcMaxPort: 10100,
  });

  console.log("Initialized MediaSoup Worker!");
})();

const mediaCodecs = [
  { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 },
  { kind: "video", mimeType: "video/VP8", clockRate: 90000 },
];

async function createRoomRouter(conversationID) {
  if (!rooms.has(conversationID)) {
    const router = await worker.createRouter({ mediaCodecs });
    rooms.set(conversationID, {
      router,
      producers: new Map(), // producerId -> producer
      producerOwners: new Map(), // producerId -> clientId
      producerSources: new Map(), // producerId -> source label
      members: new Map(), // clientId -> { userId, username }
      memberStatus: new Map(), // clientId -> { muted: boolean, cameraOff: boolean }
      transports: new Map(), // transportId -> { transport, clientId, userId, username, direction }
    });
  }

  return rooms.get(conversationID);
}

async function joinRoom(
  conversationID,
  userId,
  username,
  members,
  instance,
  clientId,
  muted,
  cameraOff,
) {
  const room = await createRoomRouter(conversationID);
  const existingUserIds = new Set(
    Array.from(room.members.values()).map((entry) => entry.userId),
  );
  room.members.set(clientId, { userId, username });
  room.memberStatus.set(clientId, {
    muted: typeof muted === "boolean" ? muted : false,
    cameraOff: typeof cameraOff === "boolean" ? cameraOff : false,
  });
  const joinedStatus = room.memberStatus.get(clientId) || {
    muted: false,
    cameraOff: false,
  };
  const participants = Array.from(room.members.entries())
    .filter(([participantClientId]) => participantClientId !== clientId)
    .map(([participantClientId, participantData]) => {
      return {
        clientId: participantClientId,
        username: participantData?.username || participantData?.userId || "",
        ...(room.memberStatus.get(participantClientId) || {
          muted: false,
          cameraOff: false,
        }),
      };
    });

  // Notify users that are already in the room, instead of trusting client-provided members.
  Array.from(existingUserIds).map(async (existingUserId) => {
    await publish(`events_${existingUserId}`, "participant-joined", {
      conversationID,
      username,
      userId,
      clientId,
      ...joinedStatus,
      timestamp: Date.now(),
      instance,
    });
  });

  await publish(`events_${userId}`, "join-room-response", {
    status: true,
    routerRtpCapabilities: room.router.rtpCapabilities,
    instance,
    clientId,
    participants,
  });

  // Late-join sync: send already active producers to newly joined user.
  for (const [producerId, producer] of room.producers.entries()) {
    const producerClientId = room.producerOwners.get(producerId);
    const ownerEntry = producerClientId
      ? room.members.get(producerClientId)
      : null;
    await publish(`events_${userId}`, "new_producer", {
      conversationID,
      username: ownerEntry?.username || username,
      userId: ownerEntry?.userId || userId,
      clientId: producerClientId,
      producerId,
      kind: producer.kind,
      rtpParameters: producer.rtpParameters,
      source: room.producerSources.get(producerId) || null,
      timestamp: Date.now(),
    });
  }
}

async function createTransport(
  conversationID,
  userId,
  username,
  instance,
  direction,
  clientId,
) {
  const room = await createRoomRouter(conversationID);

  const transport = await room.router.createWebRtcTransport({
    listenIps: [
      {
        ip: "0.0.0.0",
        announcedIp: process.env.SERVER_PUBLIC_IP,
      },
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    enableSrtp: false,
  });

  room.transports.set(transport.id, {
    transport,
    clientId,
    userId,
    username,
    direction,
  });

  await publish(`events_${userId}`, "create-transport-response", {
    response: {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    },
    direction,
    instance,
    clientId,
  });
}

async function transportConnect(
  conversationID,
  userId,
  transportId,
  dtlsParameters,
  clientId,
) {
  const room = await createRoomRouter(conversationID);
  const transportEntry = room.transports.get(transportId);
  const transport = transportEntry?.transport;

  if (!transport || transportEntry.clientId !== clientId) {
    await publish(`events_${userId}`, "transport-connect-error", {
      conversationID,
      clientId,
    });
    return;
  }

  await transport.connect({ dtlsParameters });

  await publish(`events_${userId}`, "transport-connect-response", {
    conversationID,
    message: "OK",
    clientId,
  });
}

async function produce(
  conversationID,
  transportId,
  kind,
  rtpParameters,
  userId,
  username,
  members,
  clientId,
  appData,
) {
  const room = await createRoomRouter(conversationID);
  const transportEntry = room.transports.get(transportId);
  const transport = transportEntry?.transport;

  if (!transport || transportEntry.clientId !== clientId) {
    await publish(`events_${userId}`, "produce-error", {
      conversationID,
      clientId,
    });
    return;
  }

  const producer = await transport.produce({
    kind,
    rtpParameters,
    codecOptions: {
      videoGoogleStartBitrate: 1000,
    },
  });

  await producer.resume();

  room.producers.set(producer.id, producer);
  room.producerOwners.set(producer.id, clientId);
  if (appData?.source) {
    room.producerSources.set(producer.id, appData.source);
  }

  console.log(`Producer created [${kind}] ID: ${producer.id}`);

  const recipientUserIds = Array.from(
    new Set(Array.from(room.members.values()).map((entry) => entry.userId)),
  );
  const producerOwner = room.members.get(clientId);
  const displayUsername = producerOwner?.username || username;
  const displayUserId = producerOwner?.userId || userId;

  recipientUserIds.map(async (memberUserId) => {
    await publish(`events_${memberUserId}`, "new_producer", {
      conversationID,
      username: displayUsername,
      userId: displayUserId,
      clientId,
      producerId: producer.id,
      kind,
      rtpParameters,
      source: appData?.source || room.producerSources.get(producer.id) || null,
      timestamp: Date.now(),
    });
  });

  await publish(`events_${userId}`, "produce-response", {
    conversationID,
    id: producer.id,
    clientId,
  });
}

async function consume(
  conversationID,
  userId,
  transportId,
  producerId,
  rtpCapabilities,
  clientId,
) {
  const room = await createRoomRouter(conversationID);
  const transportEntry = room.transports.get(transportId);
  const transport = transportEntry?.transport;

  if (!transport || transportEntry.clientId !== clientId) {
    await publish(`events_${userId}`, "consume-transport-error", {
      conversationID,
      clientId,
    });
    return;
  }

  if (
    !room.router.canConsume({
      producerId,
      rtpCapabilities,
    })
  ) {
    await publish(`events_${userId}`, "consume-error", {
      conversationID,
      clientId,
    });
    return;
  }

  const consumer = await transport.consume({
    producerId,
    rtpCapabilities,
  });

  console.log(`Consumer created for producer ${producerId}`);

  await publish(`events_${userId}`, "consume-response", {
    conversationID,
    id: consumer.id,
    producerId,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters,
    source: room.producerSources.get(producerId) || null,
    clientId,
  });
}

async function closeProducer(conversationID, userId, clientId, producerId) {
  const room = rooms.get(conversationID);
  if (!room) {
    return;
  }

  const owner = room.producerOwners.get(producerId);
  if (owner !== clientId) {
    return;
  }

  const producer = room.producers.get(producerId);
  if (producer) {
    try {
      producer.close();
    } catch (_) {
      // no-op
    }
  }

  room.producers.delete(producerId);
  room.producerOwners.delete(producerId);

  const notifiedUsers = new Set();
  for (const [, member] of room.members.entries()) {
    if (notifiedUsers.has(member.userId)) {
      continue;
    }
    notifiedUsers.add(member.userId);
    await publish(`events_${member.userId}`, "producer-closed", {
      conversationID,
      username: member.username || null,
      userId,
      clientId,
      producerId,
      timestamp: Date.now(),
    });
  }
}

async function leaveRoom(conversationID, userId, clientId) {
  const room = rooms.get(conversationID);

  removeParticipant(conversationID, clientId);

  if (!room) {
    return;
  }

  const closedProducerIds = [];
  for (const [producerId, owner] of room.producerOwners.entries()) {
    if (owner !== clientId) continue;

    const producer = room.producers.get(producerId);
    if (producer) {
      try {
        producer.close();
      } catch (_) {
        // no-op
      }
    }

    room.producers.delete(producerId);
    room.producerOwners.delete(producerId);
    room.producerSources.delete(producerId);
    closedProducerIds.push(producerId);
  }

  for (const [transportId, transportEntry] of room.transports.entries()) {
    if (!transportEntry || transportEntry.clientId !== clientId) continue;

    try {
      transportEntry.transport.close();
    } catch (_) {
      // no-op
    }

    room.transports.delete(transportId);
  }

  const leavingMember = room.members.get(clientId);
  room.members.delete(clientId);
  room.memberStatus.delete(clientId);
  const notifiedUsers = new Set();
  const leavingUsername = leavingMember?.username || null;
  const leavingUserId = leavingMember?.userId || userId;
  for (const [memberClientId, member] of room.members.entries()) {
    if (memberClientId === clientId || notifiedUsers.has(member.userId)) {
      continue;
    }
    notifiedUsers.add(member.userId);
    await publish(`events_${member.userId}`, "participant-left", {
      conversationID,
      username: leavingUsername,
      userId: leavingUserId,
      clientId,
      producerIds: closedProducerIds,
      timestamp: Date.now(),
    });
  }

  if (room.members.size === 0) {
    for (const [, producer] of room.producers.entries()) {
      try {
        producer.close();
      } catch (_) {
        // no-op
      }
    }

    for (const [, transportEntry] of room.transports.entries()) {
      try {
        transportEntry.transport.close();
      } catch (_) {
        // no-op
      }
    }

    rooms.delete(conversationID);
  }
}

async function participantStatus(
  conversationID,
  userId,
  clientId,
  muted,
  cameraOff,
) {
  const room = rooms.get(conversationID);
  if (!room || !room.members.has(clientId)) {
    return;
  }

  const prev = room.memberStatus.get(clientId) || {
    muted: false,
    cameraOff: false,
  };

  const nextStatus = {
    muted: typeof muted === "boolean" ? muted : prev.muted,
    cameraOff: typeof cameraOff === "boolean" ? cameraOff : prev.cameraOff,
  };

  room.memberStatus.set(clientId, nextStatus);

  const recipientUserIds = Array.from(
    new Set(Array.from(room.members.values()).map((entry) => entry.userId)),
  );
  const member = room.members.get(clientId);
  const displayUsername = member?.username || null;
  const displayUserId = member?.userId || userId;
  await Promise.all(
    recipientUserIds.map(async (memberUserId) => {
      await publish(`events_${memberUserId}`, "participant-status", {
        conversationID,
        username: displayUsername,
        userId: displayUserId,
        clientId,
        ...nextStatus,
        timestamp: Date.now(),
      });
    }),
  );
}

function webRTCEvents(event, message) {
  switch (event) {
    case "join-room-relay": {
      const {
        conversationID: cnvsIDDD,
        userId: usrId,
        username: ursnm,
        members: mmbrs,
        instance,
        clientId,
        muted,
        cameraOff,
      } = message;
      const resolvedUserId = usrId || ursnm;
      joinRoom(
        cnvsIDDD,
        resolvedUserId,
        ursnm || resolvedUserId,
        mmbrs,
        instance,
        clientId,
        muted,
        cameraOff,
      );
      break;
    }
    case "create-transport-relay":
      createTransport(
        message.conversationID,
        message.userId || message.username,
        message.username,
        message.instance,
        message.direction,
        message.clientId,
      );
      break;
    case "transport-connect-relay": {
      const {
        conversationID,
        userId,
        username,
        transportId,
        dtlsParameters,
        clientId,
      } = message;
      transportConnect(
        conversationID,
        userId || username,
        transportId,
        dtlsParameters,
        clientId,
      );
      break;
    }
    case "produce-relay": {
      const {
        conversationID: cnvsID,
        transportId: trnsptID,
        kind,
        rtpParameters,
        userId,
        username: usrnm,
        members,
        clientId,
        appData,
      } = message;
      produce(
        cnvsID,
        trnsptID,
        kind,
        rtpParameters,
        userId || usrnm,
        usrnm,
        members,
        clientId,
        appData,
      );
      break;
    }
    case "consume-relay": {
      const {
        conversationID: cnvsIDD,
        userId,
        username: usrnmm,
        transportId: trnsptIDD,
        producerId,
        rtpCapabilities,
        clientId,
      } = message;
      consume(
        cnvsIDD,
        userId || usrnmm,
        trnsptIDD,
        producerId,
        rtpCapabilities,
        clientId,
      );
      break;
    }
    case "close-producer-relay":
      closeProducer(
        message.conversationID,
        message.userId || message.username,
        message.clientId,
        message.producerId,
      );
      break;
    case "leave-room-relay":
      leaveRoom(
        message.conversationID,
        message.userId || message.username,
        message.clientId,
      );
      break;
    case "participant-status-relay":
      participantStatus(
        message.conversationID,
        message.userId || message.username,
        message.clientId,
        message.muted,
        message.cameraOff,
      );
      break;
    default:
      break;
  }
}

module.exports = {
  worker,
  rooms,
  webRTCEvents,
  createRoomRouter,
  joinRoom,
  createTransport,
  transportConnect,
  produce,
  consume,
  closeProducer,
  leaveRoom,
  participantStatus,
};
