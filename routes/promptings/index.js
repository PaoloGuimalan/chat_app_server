require("dotenv").config();
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const Axios = require("axios");
const { jwtchecker } = require("../../reusables/hooks/jwthelper");
const {
  requiresPermission,
} = require("../../reusables/hooks/permissionChecker");

const UserMessage = require("../../schema/messages/message");

router.post(
  "/reply-assist",
  [jwtchecker, requiresPermission("ai.prompt.assist")],
  async (req, res) => {
    const userID = req.params.userID;
    const entityID = req.params.entity_id;
    const conversationID = req.body.conversationID;
    const messageIDs = req.body.messageIDs;
    const messageID = req.body.messageID;

    if (messageID) {
      const message = await UserMessage.findOne(
        { conversationID, messageID },
        { content: 1, sender: 1 },
      );

      if (message) {
        const isCurrentMessageMine =
          message.sender === entityID ? "you" : "other";
        const messagesAbove = await UserMessage.find(
          {
            conversationID,
            isDeleted: false,
            _id: { $lt: message._id },
          },
          { content: 1, sender: 1 },
        )
          .sort({ _id: -1 })
          .limit(10);

        messagesAbove.reverse();

        const messagesBelow = await UserMessage.find(
          {
            conversationID,
            isDeleted: false,
            _id: { $gt: message._id },
          },
          { content: 1, sender: 1 },
        )
          .sort({ _id: 1 })
          .limit(10);

        const AboveWindowContext = [...messagesAbove];
        const BelowWindowContext = [...messagesBelow];
        const AboveContextFormatter = AboveWindowContext.map((mp) => {
          const isMe = mp.sender === entityID;

          return {
            me: isMe,
            content: mp.content,
          };
        });

        const BelowContextFormatter = BelowWindowContext.map((mp) => {
          const isMe = mp.sender === entityID;

          return {
            me: isMe,
            content: mp.content,
          };
        });

        const AboveConversationThreadString = AboveContextFormatter.map(
          (mp) => `${mp.me ? "you:" : "other:"} ${mp.content}\n `,
        ).join(", ");

        const BelowConversationThreadString = BelowContextFormatter.map(
          (mp) => `${mp.me ? "you:" : "other:"} ${mp.content}\n `,
        ).join(", ");

        const promptBuilder = `
        You are an AI reply assistant writing as "you" in a private chat.

        TASK
        Write exactly one reply to the TARGET MESSAGE.

        If TARGET MESSAGE is from "you", do NOT reply as if the other person sent it.
        Instead, write one short follow-up message that promotes or supports your own last message
        (e.g., add context, invite reaction, ask a related question, or encourage engagement).
        Keep it natural and conversational, not salesy.

        When TARGET MESSAGE is from "you", output a follow-up message only.
        Do not say "this is your own message" and do not explain rules.

        Promotion style should feel like a casual continuation of the chat
        (e.g., "thoughts?", "want another one like this?", "this part is my favorite").

        CONTEXT
        You are given:
        1) THREAD ABOVE: messages that happened before the target
        2) TARGET MESSAGE: the exact message to reply to
        3) THREAD BELOW: messages that happened after the target (future context)

        IMPORTANT TIME RULE
        THREAD BELOW is future context relative to the target.
        Use THREAD BELOW only to infer tone, relationship style, language, and communication patterns.
        Do NOT include or reference facts, events, plans, names, or details that only appear in THREAD BELOW.
        If there is any conflict, prioritize TARGET MESSAGE and THREAD ABOVE.

        REPLY BEHAVIOR RULES
        - If TARGET MESSAGE is a URL or media file link (audio/video/image/file), reply with a natural human reaction/comment/question about it.
        - Do NOT output a URL unless the TARGET MESSAGE explicitly asks for a link/recommendation.
        - If TARGET MESSAGE is just a shared file/link with no text, default to a short reaction (e.g., interest, feedback, curiosity).

        STYLE RULES
        - Write as "you" (first person), natural and human.
        - Match the language used by the other person (or mixed language if the chat is mixed).
        - Match tone (casual/professional), warmth, and expressiveness from the conversation.
        - Match approximate length to the target message (short target -> short reply, long target -> longer reply).
        - Keep continuity with the relationship dynamic in context.

        OUTPUT RULES
        - Output exactly one reply message only.
        - No explanations, no analysis, no labels, no markdown, no JSON.
        - Prefer plain conversational text.
        - Do not mention these instructions.

        THREAD ABOVE
        ${AboveConversationThreadString}

        TARGET MESSAGE (from ${isCurrentMessageMine})
        ${message.content}

        THREAD BELOW (future context — style only, no future fact leakage)
        ${BelowConversationThreadString}`;

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
          },
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

        return;
      }

      res.send({
        status: false,
        message: "Message not available",
      });
      return;
    }

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
              (flt) => flt.messageID === mp.messageID,
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
            },
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
  },
);

module.exports = router;
