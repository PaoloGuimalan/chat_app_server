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
      producers: new Map(), // producerId → producer
      members: new Set(), // sessionIds
      transports: new Map(),
    });
  }
  return rooms.get(conversationID);
}

async function joinRoom(conversationID, username, members, instance) {
  const room = await createRoomRouter(conversationID);
  room.members.add(username);

  members.map(async (mp) => {
    await publish(`events_${mp}`, "participant-joined", {
      conversationID,
      username,
      timestamp: Date.now(),
      instance,
    });
  });

  await publish(`events_${username}`, "join-room-response", {
    status: true,
    routerRtpCapabilities: room.router.rtpCapabilities,
    instance,
  });
}

async function createTransport(conversationID, username, instance, direction) {
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

  room.transports.set(transport.id, transport);

  await publish(`events_${username}`, "create-transport-response", {
    response: {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    },
    direction,
    instance,
  });
}

async function transportConnect(
  conversationID,
  username,
  transportId,
  dtlsParameters,
) {
  const room = await createRoomRouter(conversationID);
  const transport = room.transports.get(transportId);

  if (!transport) {
    await publish(`events_${username}`, "transport-connect-error", {
      conversationID,
    });

    return;
  }

  await transport.connect({ dtlsParameters });

  await publish(`events_${username}`, "transport-connect-response", {
    conversationID,
    message: "OK",
  });
}

async function produce(
  conversationID,
  transportId,
  kind,
  rtpParameters,
  username,
  members,
  track,
) {
  const room = await createRoomRouter(conversationID);
  const transport = room.transports.get(transportId);

  if (!transport) {
    await publish(`events_${username}`, "produce-error", {
      conversationID,
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

  console.log(`Producer created [${kind}] ID: ${producer.id}`);

  members.map(async (mp) => {
    await publish(`events_${mp}`, "new_producer", {
      conversationID,
      transportId,
      producerId: producer.id,
      kind,
      rtpParameters,
      timestamp: Date.now(),
    });
  });

  await publish(`events_${username}`, "produce-response", {
    conversationID,
    id: producer.id,
  });
}

async function consume(
  conversationID,
  username,
  transportId,
  producerId,
  rtpCapabilities,
) {
  const room = await createRoomRouter(conversationID);
  const transport = room.transports.get(transportId);

  if (!transport) {
    await publish(`events_${username}`, "consume-transport-error", {
      conversationID,
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
  });
}

function webRTCEvents(event, message) {
  switch (event) {
    case "join-room-relay":
      const {
        conversationID: cnvsIDDD,
        username: ursnm,
        members: mmbrs,
        instance,
      } = message;
      joinRoom(cnvsIDDD, ursnm, mmbrs, instance);
      break;
    case "create-transport-relay":
      createTransport(
        message.conversationID,
        message.username,
        message.instance,
        message.direction,
      );
      break;
    case "transport-connect-relay":
      const { conversationID, username, transportId, dtlsParameters } = message;
      transportConnect(conversationID, username, transportId, dtlsParameters);
      break;
    case "produce-relay":
      const {
        conversationID: cnvsID,
        transportId: trnsptID,
        kind,
        rtpParameters,
        username: usrnm,
        members,
        track,
      } = message;
      produce(cnvsID, trnsptID, kind, rtpParameters, usrnm, members, track);
      break;
    case "consume-relay":
      const {
        conversationID: cnvsIDD,
        username: usrnmm,
        transportId: trnsptIDD,
        producerId,
        rtpCapabilities,
      } = message;
      consume(cnvsIDD, usrnmm, trnsptIDD, producerId, rtpCapabilities);
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
};
