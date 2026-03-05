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
  leaveRoom,
  participantStatus,
} = require("../../reusables/hooks/webRTC");
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const POD_NAME = process.env.POD_NAME || process.env.HOSTNAME || "podless";

router.post("/join-room", jwtchecker, async (req, res) => {
  const conversationID = req.body.conversationID;
  const members = req.body.members;
  const instance = req.body.instance;
  const muted = req.body.muted;
  const cameraOff = req.body.cameraOff;
  const username = req.params.userID;
  const clientId = req.body.clientId || username;

  if (instance) {
    if (!instance || instance === POD_NAME) {
      joinRoom(
        conversationID,
        username,
        members,
        instance,
        clientId,
        muted,
        cameraOff,
      );
    } else {
      await publish_pub(instance, "join-room-relay", {
        conversationID,
        username,
        members,
        instance,
        clientId,
        muted,
        cameraOff,
      });
    }
  } else {
    joinRoom(
      conversationID,
      username,
      members,
      POD_NAME,
      clientId,
      muted,
      cameraOff,
    );
  }

  res.send({
    status: true,
    message: "OK",
  });
});

router.post("/create-transport", jwtchecker, async (req, res) => {
  const { conversationID, instance, direction } = req.body; // 'send' or 'recv'
  const username = req.params.userID;
  const clientId = req.body.clientId || username;

  try {
    if (!instance || instance === POD_NAME) {
      createTransport(conversationID, username, instance, direction, clientId);

      res.send({ status: true, message: "OK" });
    } else {
      await publish_pub(instance, "create-transport-relay", {
        conversationID,
        username,
        instance,
        direction,
        clientId,
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
  const clientId = req.body.clientId || username;

  try {
    if (!instance || instance === POD_NAME) {
      transportConnect(
        conversationID,
        username,
        transportId,
        dtlsParameters,
        clientId,
      );

      res.send({ status: true, message: "OK" });
    } else {
      await publish_pub(instance, "transport-connect-relay", {
        conversationID,
        username,
        transportId,
        dtlsParameters,
        clientId,
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
  } = req.body;
  const username = req.params.userID;
  const clientId = req.body.clientId || username;

  try {
    if (!instance || instance === POD_NAME) {
      produce(
        conversationID,
        transportId,
        kind,
        rtpParameters,
        username,
        members,
        clientId,
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
        clientId,
      });

      res.send({ status: true, message: "OK" });
    }
  } catch (error) {
    console.error("produce error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/consume", jwtchecker, async (req, res) => {
  const {
    conversationID,
    transportId,
    producerId,
    rtpCapabilities,
    instance,
  } = req.body;
  const username = req.params.userID;
  const clientId = req.body.clientId || username;

  try {
    if (instance === POD_NAME) {
      consume(
        conversationID,
        username,
        transportId,
        producerId,
        rtpCapabilities,
        clientId,
      );

      res.send({ status: true, message: "OK" });
    } else {
      await publish_pub(instance, "consume-relay", {
        conversationID,
        username,
        transportId,
        producerId,
        rtpCapabilities,
        clientId,
      });

      res.send({ status: true, message: "OK" });
    }
  } catch (error) {
    console.error("consume error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/leave-room", jwtchecker, async (req, res) => {
  const { conversationID, instance } = req.body;
  const username = req.params.userID;
  const clientId = req.body.clientId || username;

  try {
    if (!instance || instance === POD_NAME) {
      leaveRoom(conversationID, username, clientId);
      res.send({ status: true, message: "OK" });
    } else {
      await publish_pub(instance, "leave-room-relay", {
        conversationID,
        username,
        clientId,
      });
      res.send({ status: true, message: "OK" });
    }
  } catch (error) {
    console.error("leave-room error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/participant-status", jwtchecker, async (req, res) => {
  const { conversationID, instance, muted, cameraOff } = req.body;
  const username = req.params.userID;
  const clientId = req.body.clientId || username;

  try {
    if (!instance || instance === POD_NAME) {
      participantStatus(
        conversationID,
        username,
        clientId,
        muted,
        cameraOff,
      );
      res.send({ status: true, message: "OK" });
    } else {
      await publish_pub(instance, "participant-status-relay", {
        conversationID,
        username,
        clientId,
        muted,
        cameraOff,
      });
      res.send({ status: true, message: "OK" });
    }
  } catch (error) {
    console.error("participant-status error:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
