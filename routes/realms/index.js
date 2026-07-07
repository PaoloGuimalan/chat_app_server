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
  SyncConversationParticipants,
} = require("../../reusables/models/messages");
const { isRealmMember } = require("../../reusables/models/realms");
const { publish } = require("../../reusables/redis/pubsub");
const { hasPermission } = require("../../reusables/hooks/permissionChecker");
const router = express.Router();

router.post("/upload-media", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const id = req.params.id;
  const entityID = req.params.entity_id;

  new multiparty.Form().parse(req, async (err, fields, files) => {
    if (err) return res.status(500).json({ error: err.message });

    try {
      const realm_id = fields.realm_id[0];
      const realm_type = fields.realm_type[0];
      const media_type = fields.media_type[0];
      const image = files.image[0].path;

      const { rows } = await pool.query(
        `SELECT EXISTS (SELECT 1 FROM community_realm WHERE realm_id = $1) as realm_exists`,
        [realm_id],
      );

      if (media_type !== "profile" && media_type !== "cover_photo") {
        throw new Error("Media type mismatch");
      }

      if (rows.length <= 0 || !rows[0].realm_exists) {
        throw new Error("Realm does not exist");
      }

      if (!(await hasPermission(entityID, "realm.media.update", realm_id))) {
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
  const entityID = req.params.entity_id;

  try {
    const account_ids = req.body.account_ids;
    const realm_id = req.body.realm_id;

    await isRealmMember(realm_id, entityID);

    const { rows: users } = await pool.query(
      `SELECT username FROM user_account WHERE entity_id = ANY($1::text[])`,
      [account_ids],
    );

    // Removing yourself (leaving) is always allowed. Removing anyone else
    // requires realm.member.remove, plus a target-role-aware rule: an admin
    // can remove a plain member/moderator, but only the owner can
    // remove/demote a fellow admin or the owner (see the NOTE in
    // entity/permissions.py about this not being a flat permission).
    const restids = account_ids.filter((flt) => flt !== entityID);

    if (restids.length > 0) {
      if (!(await hasPermission(entityID, "realm.member.remove", realm_id))) {
        res.status(401).send({
          status: false,
          message: "You are not authorized to do this action",
        });
        return;
      }

      // A page's own entity can never appear as a Member row of its own
      // realm, so once switched to act as this exact realm, resolve as
      // owner tier directly instead of letting the lookup below miss and
      // wrongly deny it.
      const { rows: selfRealmActorRow } = await pool.query(
        `SELECT 1 FROM community_realm WHERE realm_id = $1 AND entity_id = $2`,
        [realm_id, entityID],
      );
      let actorRole;
      if (selfRealmActorRow.length > 0) {
        actorRole = "owner";
      } else {
        const { rows: actorRow } = await pool.query(
          `SELECT role FROM community_member WHERE entity_id = $1 AND realm_id = $2`,
          [entityID, realm_id],
        );
        actorRole = actorRow.length > 0 ? actorRow[0].role : null;
      }

      if (actorRole !== "owner") {
        const { rows: targetAdminRows } = await pool.query(
          `SELECT entity_id FROM community_member WHERE realm_id = $1 AND entity_id = ANY($2::text[]) AND role IN ('admin', 'owner')`,
          [realm_id, restids],
        );
        if (targetAdminRows.length > 0) {
          res.status(401).send({
            status: false,
            message: "Only the realm owner can remove or demote an admin.",
          });
          return;
        }
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
        `SELECT realm_id FROM community_member WHERE entity_id = ANY($1::text[]) AND realm_id = ANY($2::text[])`,
        [account_ids, channel_ids],
      );

      const joined_channel_ids = joined_channels.map((mp) => mp.realm_id);

      if (joined_channel_ids.length > 0) {
        await pool.query(
          `DELETE FROM community_member WHERE entity_id = ANY($1::text[]) AND realm_id = ANY($2::text[])`,
          [account_ids, joined_channel_ids],
        );

        await Promise.all(
          joined_channel_ids.map(async (channelID) => {
            await SyncConversationParticipants(channelID);
          }),
        );

        users.map((mp) => {
          joined_channel_ids.map((mpp) => {
            NotificationMessageForConversations(
              mpp,
              entityID,
              [],
              `${username} removed ${mp.username}`,
              "channel",
            );
          });
        });
      }
    }

    await pool.query(
      `DELETE FROM community_member WHERE entity_id = ANY($1::text[]) AND realm_id = $2`,
      [account_ids, realm_id],
    );

    await SyncConversationParticipants(realm_id);

    if (
      realm.type !== "page" &&
      realm.type !== "server" &&
      realm.type !== "voice"
    ) {
      users.map((mp) => {
        NotificationMessageForConversations(
          realm_id,
          entityID,
          [],
          `${username} removed ${mp.username}`,
          realm.type,
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
          entityID: mp,
          type: realm.type,
        },
      });
    });

    // Signal the remaining members so conference clients refetch the
    // participants list (the removed users are notified separately above).
    try {
      const { rows: remainingMembers } = await pool.query(
        `SELECT entity_id FROM community_member WHERE realm_id = $1;`,
        [realm_id],
      );

      remainingMembers.forEach((mp) => {
        publish(`events_${mp.entity_id}`, "conference_members_changed", {
          status: true,
          auth: true,
          realm_id,
        });
      });
    } catch (publishErr) {
      console.log("Failed to broadcast member removal:", publishErr);
    }

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
