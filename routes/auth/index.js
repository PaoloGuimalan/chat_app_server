require("dotenv").config();
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const Axios = require("axios");

const makeID = require("../../reusables/hooks/makeID");
const dateGetter = require("../../reusables/hooks/getDate");
const timeGetter = require("../../reusables/hooks/getTime");
const { encode, decode } = require("../../reusables/hooks/bycrypt");
const { jwtchecker } = require("../../reusables/hooks/jwthelper");
const pool = require("../../reusables/database/postgres");

const UserAccount = require("../../schema/auth/useraccount");
const UserVerification = require("../../schema/auth/userverification");
const { sseNotificationsWaiters } = require("../../reusables/hooks/sse");
const { transformUser } = require("../../reusables/hooks/transformers");
const { activeStreams } = require("../../reusables/redis/pubsub");

const MAILINGSERVICE_DOMAIN = process.env.MAILINGSERVICE;
const JWT_SECRET = process.env.JWT_SECRET;

router.use((req, res, next) => {
  next();
});

router.get("/sessions", (req, res) => {
  const sessions = Object.keys(sseNotificationsWaiters).map((mp) => ({
    connectionID: mp,
    numberOfSessions: sseNotificationsWaiters[mp].response.length,
    sessions: sseNotificationsWaiters[mp].response.map(
      (mpi) => mpi.sessionstamp,
    ),
  }));

  const formattedStreams = Object.fromEntries(
    Array.from(activeStreams.entries()).map(([channel, set]) => [
      channel,
      set instanceof Set ? set.size : 0, // Simply counts items, avoiding complex objects
    ]),
  );

  res.send({ status: true, result: sessions, streams: formattedStreams });
});

router.get("/users", jwtchecker, async (req, res) => {
  //   await UserAccount.find({})
  //     .then((result) => {
  //       res.send({ status: true, result: result });
  //     })
  //     .catch((err) => {
  //       console.log(err);
  //       res.send({ status: false, err: err.message });
  //     });
  const { rows } = await pool.query("SELECT * FROM user_account");
  res.send({ status: true, result: rows });
});

const checkUserIDExisting = async (nameID, IDMade) => {
  const combineID = `${nameID}_${IDMade}`;

  return await UserAccount.find({ userID: combineID })
    .then((result) => {
      if (result.length) {
        checkUserIDExisting(nameID, makeID(10));
      } else {
        return combineID;
      }
    })
    .catch((err) => {
      console.log(err);
      return false;
    });
};

const checkVerIDExisting = async (IDMade) => {
  return await UserVerification.find({ verID: IDMade })
    .then((result) => {
      if (result.length) {
        checkVerIDExisting(makeID(20));
      } else {
        return IDMade;
      }
    })
    .catch((err) => {
      console.log(err);
      return false;
    });
};

const sendEmailVerCode = async (from, to, subject, userID) => {
  const generatedID = makeID(6);
  const content = `
    Welcome to ChatterLoop!

    Your registration was successful! Here is your verification code for the account activation: ${generatedID}
    `;

  const newVerID = await checkVerIDExisting(makeID(20));

  const newVerRecord = new UserVerification({
    verID: newVerID,
    userID: userID,
    verCode: generatedID,
    dateGenerated: {
      date: dateGetter(),
      time: timeGetter(),
    },
    isUsed: false,
  });

  Axios.post(`${MAILINGSERVICE_DOMAIN}/sendEmail`, {
    from: from,
    email: to,
    subject: subject,
    content: content,
  })
    .then((response) => {
      if (response.data.status) {
        //action needed to save verification code in db
        newVerRecord
          .save()
          .then(() => {})
          .catch((err) => {
            console.log(err);
          });
      }
    })
    .catch((err) => {
      console.log(err);
    });
};

const checkEmailExisting = async (email) => {
  return await UserAccount.find({ email: email })
    .then((result) => {
      if (result.length) {
        return true;
      } else {
        return false;
      }
    })
    .catch((err) => {
      console.log(err);
      return false;
    });
};

router.get("/jwtchecker", jwtchecker, async (req, res) => {
  const userID = req.params.userID;

  const { rows } = await pool.query(
    "SELECT * FROM user_account WHERE id = $1",
    [userID],
  );

  if (rows.length > 0) {
    const currentRow = transformUser(rows[0]);
    const usertoken = jwt.sign(
      {
        ...currentRow,
        password: null,
      },
      JWT_SECRET,
      {
        expiresIn: 60 * 60 * 24 * 7,
      },
    );

    res.send({
      status: true,
      result: {
        usertoken: usertoken,
      },
    });
  } else {
    res.send({ status: false, message: "Cannot verify user!" });
  }
});

module.exports = router;
