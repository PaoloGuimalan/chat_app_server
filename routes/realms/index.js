require("dotenv").config();
const express = require("express");
const { jwtchecker } = require("../../reusables/hooks/jwthelper");
const pool = require("../../reusables/database/postgres");
const Storage = require("../../reusables/hooks/storage");
const multiparty = require("multiparty");
const fs = require("fs/promises");
const makeid = require("../../reusables/hooks/makeID");
const {
  NotificationMessageForConversations,
} = require("../../reusables/models/messages");
const { isRealmMember } = require("../../reusables/models/realms");
const { publish } = require("../../reusables/redis/pubsub");
const router = express.Router();

router.post("/upload-media", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const id = req.params.id;

  new multiparty.Form().parse(req, async (err, fields, files) => {
    if (err) return res.status(500).json({ error: err.message });

    try {
      const realm_id = fields.realm_id[0];
      const realm_type = fields.realm_type[0];
      const media_type = fields.media_type[0];
      const image = files.image[0].path;

      const { rows } = await pool.query(
        `
        SELECT 
            EXISTS (SELECT 1 FROM community_realm WHERE realm_id = $1) as realm_exists,
            EXISTS (
            SELECT 1 
            FROM community_member cm
            JOIN community_realm cr ON cm.realm_id = cr.realm_id
            WHERE cr.realm_id = $1 
                AND cm.account_id = $2 
                AND cm.role = 'admin'
            ) as is_admin
        `,
        [realm_id, id],
      );

      if (media_type !== "profile" && media_type !== "cover_photo") {
        throw new Error("Media type mismatch");
      }

      if (rows.length <= 0) {
        throw new Error("Realm does not exist");
      }

      if (!rows[0].realm_exists || !rows[0].is_admin) {
        throw new Error("You do not have permission to make this action.");
      }

      const imageBuffer = await fs.readFile(image);

      const imageUpload = await Storage.upload(
        `${makeid(10)}_${files.image[0].originalFilename}`,
        imageBuffer,
        `uploads/${realm_type}s/${realm_id}`,
      );

      if (imageUpload) {
        if (media_type === "profile") {
          await pool.query(
            `UPDATE community_realm
                        SET profile = $1
                        WHERE realm_id = $2
                      `,
            [imageUpload, realm_id],
          );
        }

        if (media_type === "cover_photo") {
          await pool.query(
            `UPDATE community_realm
                        SET cover_photo = $1
                        WHERE realm_id = $2
                      `,
            [imageUpload, realm_id],
          );
        }
        res.send({
          status: true,
          message: `Upload successful!`,
          details: { media_type, url: imageUpload },
        });
      } else {
        throw new Error("Error occured during upload");
      }
    } catch (ex) {
      res
        .status(500)
        .send({ status: false, message: ex.message || ex.toString() });
      console.log(ex);
    }
  });
});

router.delete("/remove-user", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const username = req.params.username;
  const id = req.params.id;

  try {
    const account_ids = req.body.account_ids;
    const realm_id = req.body.realm_id;

    await isRealmMember(realm_id, id);

    const { rows: users } = await pool.query(
      `SELECT username FROM user_account WHERE id = ANY($1::text[])`,
      [account_ids],
    );

    const { rows: row } = await pool.query(
      `SELECT member_id FROM community_member WHERE account_id = $1 AND realm_id = $2 AND role = $3;`,
      [id, realm_id, "admin"],
    );

    if (row.length === 0) {
      const restids = account_ids.filter((flt) => flt !== id);

      if (restids.length > 0) {
        res.status(401).send({
          status: false,
          message: "You are not authorized to do this action",
        });
        return;
      }
    }

    const { rows: realm_row } = await pool.query(
      `SELECT * FROM community_realm WHERE realm_id = $1`,
      [realm_id],
    );

    if (realm_row.length <= 0) {
      res.status(400).send({
        status: false,
        message: "No realm found",
      });
      return;
    }

    const realm = realm_row[0];

    if (realm.type === "server") {
      const { rows: channels } = await pool.query(
        `SELECT realm_id FROM community_realm WHERE parent_id = $1`,
        [realm_id],
      );

      const channel_ids = channels.map((mp) => mp.realm_id);

      const { rows: joined_channels } = await pool.query(
        `SELECT realm_id FROM community_member WHERE account_id = ANY($1::text[]) AND realm_id = ANY($2::text[])`,
        [account_ids, channel_ids],
      );

      const joined_channel_ids = joined_channels.map((mp) => mp.realm_id);

      if (joined_channel_ids.length > 0) {
        await pool.query(
          `DELETE FROM community_member WHERE account_id = ANY($1::text[]) AND realm_id = ANY($2::text[])`,
          [account_ids, joined_channel_ids],
        );

        users.map((mp) => {
          joined_channel_ids.map((mpp) => {
            NotificationMessageForConversations(
              mpp,
              userID,
              [],
              `${username} removed ${mp.username}`,
              "server",
            );
          });
        });
      }
    }

    await pool.query(
      `DELETE FROM community_member WHERE account_id = ANY($1::text[]) AND realm_id = $2`,
      [account_ids, realm_id],
    );

    if (realm.type !== "page" && realm.type !== "server") {
      users.map((mp) => {
        NotificationMessageForConversations(
          realm_id,
          userID,
          [],
          `${username} removed ${mp.username}`,
          realm.parent_id ? "server" : realm.type,
        );
      });
    }

    account_ids.map((mp) => {
      publish(`events_${mp}`, "removed_user_notif", {
        status: true,
        auth: true,
        onseen: false,
        message: `User removed from realm ${realm_id}`,
        result: {
          realm_id,
          userID: mp,
          type:
            realm.type === "group" && realm.parent_id ? "channel" : realm.type,
        },
      });
    });

    res.send({
      status: true,
      message: "OK",
    });
  } catch (ex) {
    res
      .status(500)
      .send({ status: false, message: ex.message || ex.toString() });
    console.log(ex);
  }
});

module.exports = router;
