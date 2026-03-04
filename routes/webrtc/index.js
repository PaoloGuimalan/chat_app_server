require("dotenv").config();
const express = require("express");
const mediasoup = require("mediasoup");
const { jwtchecker, createJWT } = require("../../reusables/hooks/jwthelper");
const { publish_pub, publish } = require("../../reusables/redis/pubsub");
const {
  createRoomRouter,
  createTransport,
  transportConnect,
  produce,
  consume,
  joinRoom,
} = require("../../reusables/hooks/webRTC");
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const POD_NAME = process.env.POD_NAME || process.env.HOSTNAME || "podless";

router.post("/join-room", jwtchecker, async (req, res) => {
  const conversationID = req.body.conversationID;
  const members = req.body.members;
  const instance = req.body.instance;
  const username = req.params.userID;

  if (instance) {
    if (instance === POD_NAME) {
      joinRoom(conversationID, username, members, instance);
    } else {
      await publish_pub(instance, "join-room-relay", {
        conversationID,
        username,
        members,
        instance,
      });
    }
  } else {
    joinRoom(conversationID, username, members, POD_NAME);
  }

  res.send({
    status: true,
    message: "OK",
  });
});

router.post("/create-transport", jwtchecker, async (req, res) => {
  const { conversationID, instance, direction } = req.body; // 'send' or 'recv'
  const username = req.params.userID;

  try {
    if (instance === POD_NAME) {
      createTransport(conversationID, username, instance, direction);

      res.send({ status: true, message: "OK" });
    } else {
      await publish_pub(instance, "create-transport-relay", {
        conversationID,
        username,
        instance,
        direction,
      });

      res.send({ status: true, message: "OK" });
    }
  } catch (error) {
    console.error("create-transport error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/transport-connect", jwtchecker, async (req, res) => {
  const { conversationID, transportId, dtlsParameters, instance } = req.body;
  const username = req.params.userID;

  try {
    if (instance === POD_NAME) {
      transportConnect(conversationID, username, transportId, dtlsParameters);

      res.send({ status: true, message: "OK" });
    } else {
      await publish_pub(instance, "transport-connect-relay", {
        conversationID,
        username,
        transportId,
        dtlsParameters,
      });

      res.send({ status: true, message: "OK" });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/produce", jwtchecker, async (req, res) => {
  const {
    conversationID,
    transportId,
    kind,
    rtpParameters,
    instance,
    members,
    track,
  } = req.body;
  const username = req.params.userID;

  try {
    if (instance === POD_NAME) {
      produce(
        conversationID,
        transportId,
        kind,
        rtpParameters,
        username,
        members,
        track,
      );

      res.send({ status: true, message: "OK" });
    } else {
      await publish_pub(instance, "produce-relay", {
        conversationID,
        transportId,
        kind,
        rtpParameters,
        username,
        members,
        track,
      });

      res.send({ status: true, message: "OK" });
    }
  } catch (error) {
    console.error("produce error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/consume", jwtchecker, async (req, res) => {
  const { conversationID, transportId, producerId, rtpCapabilities, instance } =
    req.body;
  const username = req.params.userID;

  try {
    if (instance === POD_NAME) {
      consume(
        conversationID,
        username,
        transportId,
        producerId,
        rtpCapabilities,
      );

      res.send({ status: true, message: "OK" });
    } else {
      await publish_pub(instance, "consume-relay", {
        conversationID,
        username,
        transportId,
        producerId,
        rtpCapabilities,
      });

      res.send({ status: true, message: "OK" });
    }
  } catch (error) {
    console.error("consume error:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
