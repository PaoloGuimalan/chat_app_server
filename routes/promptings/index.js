require("dotenv").config();
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const Axios = require("axios");
const { jwtchecker } = require("../../reusables/hooks/jwthelper");

const UserMessage = require("../../schema/messages/message");

router.post("/reply-assist", [jwtchecker], async (req, res) => {
  const userID = req.params.userID;
  const conversationID = req.body.conversationID;
  const messageIDs = req.body.messageIDs;

  await UserMessage.aggregate([
    {
      $match: {
        $and: [
          {
            conversationID: conversationID,
          },
          {
            messageID: { $in: messageIDs.map((mp) => mp.messageID) },
          },
        ],
      },
    },
  ])
    .then((result) => {
      // console.log(result.reverse())
      if (result.length > 0) {
        const resultMapper = messageIDs.map((mp) => {
          const filterMatchedResult = result.filter(
            (flt) => flt.messageID === mp.messageID
          )[0];

          return {
            ...mp,
            message: filterMatchedResult.content,
          };
        });

        const conversationThreadString = resultMapper
          .map((mp) => `${mp.me ? "me:" : "other:"} ${mp.message}`)
          .join(", ");

        const promptBuilder = `Pretend you are me and you are the one talking to the other person I am talking with. Can you reply this message for me '${
          resultMapper[resultMapper.length - 1].message
        }'. Use this context I have provided to answer better, it is the selected thread of our conversation '${conversationThreadString}'. Note that speak also using the language the person I am talking to. Also, match your message length base on how long and expressive also the message I recieved. Do also reply using tones base on how professional or casual the message is. Do not add any extra messages, just the appropriate response.`;

        Axios.post(
          process.env.GROQ_API,
          {
            model: process.env.GROQ_MODEL,
            messages: [
              {
                role: "user",
                content: promptBuilder,
              },
            ],
          },
          {
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            },
          }
        )
          .then((response) => {
            if (response.status) {
              res.send({
                status: true,
                message: response.data.choices[0].message.content,
              });
            } else {
              res.send({
                status: false,
                message: response.data,
              });
            }
          })
          .catch((err) => {
            res.send({
              status: false,
              message: err.message,
            });
          });
      } else {
        res.send({
          status: false,
          message: "No context detected",
        });
      }
    })
    .catch((err) => {
      console.log(err);
      res.send({
        status: false,
        message: "Error generating conversations list",
      });
    });
});

module.exports = router;
