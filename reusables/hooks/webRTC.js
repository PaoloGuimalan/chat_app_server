require("dotenv").config();
const mediasoup = require("mediasoup");
const { publish } = require("../redis/pubsub");

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
      members: new Map(), // clientId -> username
      transports: new Map(), // transportId -> { transport, clientId, username, direction }
    });
  }

  return rooms.get(conversationID);
}

async function joinRoom(conversationID, username, members, instance, clientId) {
  const room = await createRoomRouter(conversationID);
  const existingUsernames = new Set(room.members.values());
  room.members.set(clientId, username);
  const participants = Array.from(room.members.entries())
    .filter(([participantClientId]) => participantClientId !== clientId)
    .map(([participantClientId, participantUsername]) => ({
      clientId: participantClientId,
      username: participantUsername,
    }));

  // Notify users that are already in the room, instead of trusting client-provided members.
  Array.from(existingUsernames)
    .filter((mp) => mp !== username)
    .map(async (mp) => {
    await publish(`events_${mp}`, "participant-joined", {
      conversationID,
      username,
      clientId,
      timestamp: Date.now(),
      instance,
    });
  });

  await publish(`events_${username}`, "join-room-response", {
    status: true,
    routerRtpCapabilities: room.router.rtpCapabilities,
    instance,
    clientId,
    participants,
  });

  // Late-join sync: send already active producers to newly joined user.
  for (const [producerId, producer] of room.producers.entries()) {
    const producerClientId = room.producerOwners.get(producerId);
    await publish(`events_${username}`, "new_producer", {
      conversationID,
      username: room.members.get(producerClientId) || username,
      clientId: producerClientId,
      producerId,
      kind: producer.kind,
      rtpParameters: producer.rtpParameters,
      timestamp: Date.now(),
    });
  }
}

async function createTransport(
  conversationID,
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
    username,
    direction,
  });

  await publish(`events_${username}`, "create-transport-response", {
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
  username,
  transportId,
  dtlsParameters,
  clientId,
) {
  const room = await createRoomRouter(conversationID);
  const transportEntry = room.transports.get(transportId);
  const transport = transportEntry?.transport;

  if (!transport || transportEntry.clientId !== clientId) {
    await publish(`events_${username}`, "transport-connect-error", {
      conversationID,
      clientId,
    });
    return;
  }

  await transport.connect({ dtlsParameters });

  await publish(`events_${username}`, "transport-connect-response", {
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
  username,
  members,
  clientId,
) {
  const room = await createRoomRouter(conversationID);
  const transportEntry = room.transports.get(transportId);
  const transport = transportEntry?.transport;

  if (!transport || transportEntry.clientId !== clientId) {
    await publish(`events_${username}`, "produce-error", {
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

  console.log(`Producer created [${kind}] ID: ${producer.id}`);

  const recipientUsernames = Array.from(new Set(room.members.values())).filter(
    (mp) => mp !== username,
  );

  recipientUsernames.map(async (mp) => {
    await publish(`events_${mp}`, "new_producer", {
      conversationID,
      username,
      clientId,
      producerId: producer.id,
      kind,
      rtpParameters,
      timestamp: Date.now(),
    });
  });

  await publish(`events_${username}`, "produce-response", {
    conversationID,
    id: producer.id,
    clientId,
  });
}

async function consume(
  conversationID,
  username,
  transportId,
  producerId,
  rtpCapabilities,
  clientId,
) {
  const room = await createRoomRouter(conversationID);
  const transportEntry = room.transports.get(transportId);
  const transport = transportEntry?.transport;

  if (!transport || transportEntry.clientId !== clientId) {
    await publish(`events_${username}`, "consume-transport-error", {
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
    await publish(`events_${username}`, "consume-error", {
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

  await publish(`events_${username}`, "consume-response", {
    conversationID,
    id: consumer.id,
    producerId,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters,
    clientId,
  });
}

async function leaveRoom(conversationID, username, clientId) {
  const room = rooms.get(conversationID);
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

  room.members.delete(clientId);
  const notifiedUsers = new Set();
  for (const [memberClientId, memberUsername] of room.members.entries()) {
    if (memberClientId === clientId || notifiedUsers.has(memberUsername)) {
      continue;
    }
    notifiedUsers.add(memberUsername);
    await publish(`events_${memberUsername}`, "participant-left", {
      conversationID,
      username,
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

function webRTCEvents(event, message) {
  switch (event) {
    case "join-room-relay": {
      const {
        conversationID: cnvsIDDD,
        username: ursnm,
        members: mmbrs,
        instance,
        clientId,
      } = message;
      joinRoom(cnvsIDDD, ursnm, mmbrs, instance, clientId);
      break;
    }
    case "create-transport-relay":
      createTransport(
        message.conversationID,
        message.username,
        message.instance,
        message.direction,
        message.clientId,
      );
      break;
    case "transport-connect-relay": {
      const {
        conversationID,
        username,
        transportId,
        dtlsParameters,
        clientId,
      } = message;
      transportConnect(
        conversationID,
        username,
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
        username: usrnm,
        members,
        clientId,
      } = message;
      produce(cnvsID, trnsptID, kind, rtpParameters, usrnm, members, clientId);
      break;
    }
    case "consume-relay": {
      const {
        conversationID: cnvsIDD,
        username: usrnmm,
        transportId: trnsptIDD,
        producerId,
        rtpCapabilities,
        clientId,
      } = message;
      consume(
        cnvsIDD,
        usrnmm,
        trnsptIDD,
        producerId,
        rtpCapabilities,
        clientId,
      );
      break;
    }
    case "leave-room-relay":
      leaveRoom(message.conversationID, message.username, message.clientId);
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
  leaveRoom,
};
