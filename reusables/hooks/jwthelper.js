require("dotenv").config();
const jwt = require("jsonwebtoken");
const UserAccount = require("../../schema/auth/useraccount");
const pool = require("../database/postgres");
const { decryptNonce } = require("./crypto");
const { isUniqueNonce } = require("../redis/pubsub");
const message = require("../../schema/messages/message");
const JWT_SECRET = process.env.JWT_SECRET;

const jwtchecker = (req, res, next) => {
  const token = req.headers["x-access-token"];
  const origin = req.headers["origin"];
  const nonce = req.headers["x-nonce"];

  if (!origin) {
    res.status(403).send({ status: false, message: "Request not allowed!" });
    return;
  }

  if (!nonce) {
    res.status(403).send({ status: false, message: "Request not allowed!" });
    return;
  }

  const decrypted = decryptNonce(nonce);

  if (!decrypted) {
    res.status(403).send({
      status: false,
      message: "Request not allowed! Invalid request.",
    });
    return;
  }

  if (token) {
    jwt.verify(token, JWT_SECRET, async (err, decode) => {
      if (err) {
        console.log(err);
        res.send({ status: false, message: err.message });
      } else {
        const id = decode.userID;
        const { rows } = await pool.query(
          "SELECT id, username FROM user_account WHERE username = $1",
          [id],
        );

        const now = Math.floor(Date.now() / 1000);
        if (Math.abs(now - decrypted.timestamp) > 60) {
          return res.status(401).send({
            status: false,
            message: "Request expired. Please sync your clock.",
          });
        }

        const isNonceValid = await isUniqueNonce(
          decrypted.userId,
          decrypted.timestamp,
          decrypted.random,
        );
        if (!isNonceValid)
          return res
            .status(429)
            .send({ status: false, message: "Replay attack detected!" });

        if (rows.length > 0) {
          const currentRow = rows[0];
          req.params.userID = currentRow.username;
          req.params.id = currentRow.id;
          next();
        } else {
          res.send({ status: false, message: "Cannot verify user!" });
        }
      }
    });
  } else {
    res.send({ status: false, message: "Cannot verify user!" });
  }
};

const jwtssechecker = (req, res, next) => {
  try {
    const decodedToken = jwt.verify(req.params.token, JWT_SECRET);

    const token = decodedToken.token;
    const type = decodedToken.type;

    const origin = req.headers["origin"];

    if (!origin) {
      res.status(403).send({ status: false, message: "Request not allowed!" });
      return;
    }

    if (token) {
      jwt.verify(token, JWT_SECRET, async (err, decode) => {
        if (err) {
          res.sse(type, { status: false, auth: false, message: err.message });
        } else {
          const id = decode.userID;
          const { rows } = await pool.query(
            "SELECT id, username FROM user_account WHERE username = $1",
            [id],
          );

          if (rows.length > 0) {
            const currentRow = rows[0];
            req.params.userID = currentRow.username;
            next();
          } else {
            res.sse(type, {
              status: false,
              auth: false,
              message: "Cannot verify user!",
            });
          }
        }
      });
    } else {
      res.sse(type, {
        status: false,
        auth: false,
        message: "Cannot verify user!",
      });
    }
  } catch (ex) {
    // console.log(ex);
    res.send(type, {
      status: false,
      auth: false,
      message: "Session Expired!",
    });
  }
};

const createJWT = (payload) => {
  const encodedResult = jwt.sign(
    {
      data: payload,
    },
    JWT_SECRET,
  );

  return encodedResult;
};

const createJWTwExp = (payload) => {
  const encodedResult = jwt.sign(payload, JWT_SECRET, {
    expiresIn: 60 * 60 * 24 * 7,
  });

  return encodedResult;
};

module.exports = {
  jwtchecker,
  jwtssechecker,
  createJWT,
  createJWTwExp,
};
