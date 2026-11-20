require("dotenv").config();
const express = require("express");
const { jwtchecker } = require("../../reusables/hooks/jwthelper");
const pool = require("../../reusables/database/postgres");
const {
  MediaUploadError,
  resolveUploadByID,
  attachRecords,
} = require("../../reusables/media/uploads");
const { publishRelease } = require("../../reusables/media/release");
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
const { assertCanRemoveMembers } = require("../../reusables/models/realmRolePolicy");
const { createCommunityMediaPost } = require("../posts");
const router = express.Router();

const REALM_MEDIA_COLUMN = { profile: "profile", cover_photo: "cover_photo" };

/**
 * Points a realm's avatar or cover at `upload` (a stored file record) and
 * lets the one it replaces go - deleted unless something else still uses it
 * (reusables/media/release.js decides).
 */
const applyRealmMedia = async (realm_id, media_type, upload) => {
  const column = REALM_MEDIA_COLUMN[media_type];
  const { rows: before } = await pool.query(
    `SELECT ${column} AS url FROM community_realm WHERE realm_id = $1`,
    [realm_id],
  );
  const url = upload.fileDetails.data;
  await pool.query(`UPDATE community_realm SET ${column} = $1 WHERE realm_id = $2`, [
    url,
    realm_id,
  ]);
  const target = { type: "realm_media", id: String(realm_id) };
  attachRecords([upload], target);
  const previous = before[0]?.url;
  if (previous && previous !== url) {
    publishRelease([{ target, urls: [previous] }]);
  }
  return url;
};

// { realm_id, media_type, uploadID, caption? } - the photo already uploaded straight to
// storage through /media/uploads.
router.post("/upload-media", jwtchecker, async (req, res) => {
  const id = req.params.id;
  const entityID = req.params.entity_id;
  try {
    const { realm_id, media_type, uploadID, caption } = req.body || {};
    if (!REALM_MEDIA_COLUMN[media_type]) throw new MediaUploadError("Media type mismatch");
    if (!(await hasPermission(entityID, "realm.media.update", realm_id, { fresh: true }))) {
      throw new MediaUploadError("You do not have permission to make this action.", 403);
    }
    const upload = await resolveUploadByID({
      accountID: id,
      uploadID,
      purposes: [media_type === "profile" ? "avatar" : "cover"],
      realmID: realm_id,
    });
    if (upload.kind !== "image") throw new MediaUploadError("Only photos can be used here");
    const { rows: realms } = await pool.query(
      `SELECT type FROM community_realm WHERE realm_id = $1`,
      [realm_id],
    );
    if (!realms.length) throw new MediaUploadError("Realm not available", 404);
    if (realms[0].type === "community") {
      const { postID } = await createCommunityMediaPost({
        params: req.params,
        realmID: realm_id,
        mediaType: media_type,
        upload,
        caption,
      });
      res.send({
        status: true,
        message: "Upload successful!",
        details: { media_type, url: upload.fileDetails.data, post_id: postID },
      });
      return;
    }
    const url = await applyRealmMedia(realm_id, media_type, upload);
    res.send({ status: true, message: `Upload successful!`, details: { media_type, url } });
  } catch (ex) {
    res
      .status(ex.status || 500)
      .send({ status: false, message: ex.message || ex.toString() });
    console.log(ex);
  }
});

router.delete("/remove-user", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const username = req.params.username;
  const id = req.params.id;
  const entityID = req.params.entity_id;
  let client;
  let transactionOpen = false;
  const afterCommit = [];

  try {
    // entityID is the ACTING entity - removing a member while switched to the
    // page must read as the page, not the human behind it. `username` stays
    // as the fallback.
    const actorDetails = await GetSenderDetails(entityID);
    const actorHandle = actorDetails?.handle || username;
    const account_ids = req.body.account_ids;
    const realm_id = req.body.realm_id;

    await isRealmMember(realm_id, entityID, { forMessaging: false });

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

    client = await pool.getPool().connect();
    await client.query("BEGIN");
    transactionOpen = true;
    const { realm } = await assertCanRemoveMembers(client, {
      actorID: entityID, realmID: realm_id, entityIDs: account_ids,
    }, hasPermission);

    if (realm.type === "server") {
      const { rows: channels } = await client.query(
        `SELECT realm_id FROM community_realm WHERE parent_id = $1`,
        [realm_id],
      );

      const channel_ids = channels.map((mp) => mp.realm_id);

      // The channel's own type comes back with it. Without it the fan-out below
      // had to guess, and it guessed "channel" for every row - including VOICE
      // rooms, which then got a notif message written for them (stored as
      // conversationType "channel", for a conversation that is neither).
      const { rows: joined_channels } = await client.query(
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
        await client.query(
          `DELETE FROM community_member WHERE entity_id = ANY($1::text[]) AND realm_id = ANY($2::text[])`,
          [account_ids, joined_channel_ids],
        );

        afterCommit.push(() => Promise.all(
          joined_channel_ids.map(async (channelID) => {
            await SyncConversationParticipants(channelID);
          }),
        ));

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

            afterCommit.push(() => { NotificationMessageForConversations(
              mpp,
              entityID,
              [],
              membershipMessage(mp),
              channelType,
            ); });
          });
        });
      }
    }

    await client.query(
      `DELETE FROM community_member WHERE entity_id = ANY($1::text[]) AND realm_id = $2`,
      [account_ids, realm_id],
    );
    await client.query("COMMIT");
    transactionOpen = false;
    client.release();
    client = null;
    for (const effect of afterCommit) await effect();

    if (realm.type !== "community") {
      await SyncConversationParticipants(realm_id);
    }

    if (
      realm.type !== "page" &&
      realm.type !== "server" &&
      realm.type !== "community" &&
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
      .status(ex.code === "OWNERSHIP_TRANSFER" ? 400 : ex.status || 500)
      .send({ status: false, message: ex.message || ex.toString() });
    console.log(ex);
  } finally {
    if (transactionOpen) {
      try { await client.query("ROLLBACK"); } catch (error) { console.error("Member removal rollback failed", error); }
    }
    if (client) client.release();
  }
});

module.exports = router;
