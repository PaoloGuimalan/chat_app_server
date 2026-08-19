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
const {
  GetSenderDetails,
  GetEntityHandles,
} = require("../../reusables/models/users");
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
        entityID,
        imageBuffer,
        `${makeid(10)}_${files.image[0].originalFilename}`,
        {
          referenceIDs: [id, realm_id, entityID],
          action: media_type,
        },
        `uploads/${realm_type}s/${realm_id}`,
      );

      if (imageUpload) {
        if (media_type === "profile") {
          await pool.query(
            `UPDATE community_realm
                        SET profile = $1
                        WHERE realm_id = $2
                      `,
            [imageUpload.fileDetails.data, realm_id],
          );
        }

        if (media_type === "cover_photo") {
          await pool.query(
            `UPDATE community_realm
                        SET cover_photo = $1
                        WHERE realm_id = $2
                      `,
            [imageUpload.fileDetails.data, realm_id],
          );
        }
        res.send({
          status: true,
          message: `Upload successful!`,
          details: { media_type, url: imageUpload.fileDetails.data },
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
    // entityID is the ACTING entity - removing a member while switched to the
    // page must read as the page, not the human behind it. `username` stays
    // as the fallback.
    const actorDetails = await GetSenderDetails(entityID);
    const actorHandle = actorDetails?.handle || username;
    const account_ids = req.body.account_ids;
    const realm_id = req.body.realm_id;

    await isRealmMember(realm_id, entityID);

    // Handles for whoever is being removed, person OR page. This used to select
    // FROM user_account, which has no row for a page - so removing a page
    // produced an EMPTY list and therefore no system message at all, and a mixed
    // batch named only the people in it.
    const targetHandles = await GetEntityHandles(account_ids);
    const users = account_ids.map((mp) => ({
      // The raw id only when an entity resolves to neither kind - better than
      // "undefined removed" in a message people read.
      username: targetHandles.get(String(mp))?.handle || String(mp),
      // Leaving IS removing yourself through this same route, so the only
      // thing separating the two is whether the target is the actor.
      isSelf: String(mp) === String(entityID),
    }));

    // ...which is what this reads, so a self-removal doesn't announce itself
    // as "paulo removed paulo". A mixed batch (an admin clearing out several
    // people, one of whom is themselves) gets the right sentence per person,
    // since it is decided per target rather than per request.
    const membershipMessage = (target) =>
      target.isSelf
        ? `${target.username} left`
        : `${actorHandle} removed ${target.username}`;

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

    // A realm can't be left with zero owners - whether via self-leave or an
    // owner removing a co-owner (only an owner can remove/demote a fellow
    // owner, per the actorRole check above), so this covers the whole
    // batch, not just self-removal.
    const { rows: ownerRows } = await pool.query(
      `SELECT entity_id FROM community_member WHERE realm_id = $1 AND role = 'owner'`,
      [realm_id],
    );
    const currentOwnerIds = ownerRows.map((mp) => mp.entity_id);
    const ownersBeingRemoved = account_ids.filter((flt) =>
      currentOwnerIds.includes(flt),
    );

    if (
      ownersBeingRemoved.length > 0 &&
      ownersBeingRemoved.length >= currentOwnerIds.length
    ) {
      res.status(400).send({
        status: false,
        message: "Transfer ownership to another member before leaving.",
      });
      return;
    }

    if (realm.type === "server") {
      const { rows: channels } = await pool.query(
        `SELECT realm_id FROM community_realm WHERE parent_id = $1`,
        [realm_id],
      );

      const channel_ids = channels.map((mp) => mp.realm_id);

      // The channel's own type comes back with it. Without it the fan-out below
      // had to guess, and it guessed "channel" for every row - including VOICE
      // rooms, which then got a notif message written for them (stored as
      // conversationType "channel", for a conversation that is neither).
      const { rows: joined_channels } = await pool.query(
        `SELECT cm.realm_id, cr.type
           FROM community_member cm
           JOIN community_realm cr ON cr.realm_id = cm.realm_id
          WHERE cm.entity_id = ANY($1::text[])
            AND cm.realm_id = ANY($2::text[])`,
        [account_ids, channel_ids],
      );

      // De-duplicated: the query returns one row per (member, channel), so
      // removing three people from one channel used to yield that channel three
      // times - and the notification loop below is already per-member, so the
      // messages multiplied.
      const joined_channel_types = new Map(
        joined_channels.map((mp) => [mp.realm_id, mp.type]),
      );
      const joined_channel_ids = [...joined_channel_types.keys()];

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
            const channelType = joined_channel_types.get(mpp);
            // A voice room has no chat history to write this into. This is
            // where the fix belongs - the type comes from the channel row
            // above, so the guard is reading the database rather than a
            // hardcoded guess.
            if (channelType === "voice") {
              return;
            }

            NotificationMessageForConversations(
              mpp,
              entityID,
              [],
              membershipMessage(mp),
              channelType,
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
          membershipMessage(mp),
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

        // The same fact in the shape the servers UI reads - `realm_id` on the
        // frame body is what the conference clients look for, and everything
        // else on this stream carries its payload under `result`. Sent
        // alongside rather than instead of the conference event so the
        // conference clients keep the frame they already parse.
        publish(`events_${mp.entity_id}`, "realm_membership_changed", {
          status: true,
          auth: true,
          message: `Members removed from realm ${realm_id}`,
          result: {
            realm_id,
            type: realm.type,
            action: "removed",
            entity_ids: account_ids,
          },
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
