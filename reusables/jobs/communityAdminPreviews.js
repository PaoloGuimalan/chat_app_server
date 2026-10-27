const { randomUUID, createHash } = require("node:crypto");

const COOLDOWN_MS = 5 * 60 * 1000;
const POLL_MS = 15 * 1000;
const LEASE_MS = 60 * 1000;
const ACTIVITY_TYPE = "community_admin_activity";
const unwrap = (result) => result && Object.hasOwn(result, "value") ? result.value : result;

function previewNotification(state, count, now) {
  const notificationID = "NTF_community_preview_" + createHash("sha256")
    .update(state._id + ":" + state.batch_id).digest("hex");
  return {
    notificationID,
    preview_key: state._id,
    referenceID: state.community_entity_id,
    referenceStatus: true,
    toUserID: state.admin_entity_id,
    fromUserID: state.community_entity_id,
    community_entity_id: state.community_entity_id,
    is_anonymous: false,
    type: ACTIVITY_TYPE,
    activity_count: count,
    activity_revision: state.generation,
    activity_snapshot_version: 1,
    activity_delivery_id: state.batch_id,
    activity_delivery_version: state.generation,
    isRead: false,
    content: {
      headline: "Community activity",
      details: count + " new " + (count === 1 ? "activity" : "activities") +
        " in your community. Check them out.",
    },
    date: { date: now.toISOString() },
    target: { type: "community_notifications", supportingID: state.realm_id },
    redirects: ["web", "android", "ios"].map((platform) => ({
      platform, type: "community_notifications",
      route: platform === "web"
        ? "/realms/" + encodeURIComponent(state.realm_id) + "/notifications"
        : "/realm/" + encodeURIComponent(state.realm_id) + "/manage/notifications",
    })),
  };
}

function createPreviewDispatcher({ deliveries, receipts, notifications, snapshots, authorize, publish, now = () => new Date() }) {
  async function freezeReceiptIds(state, unread) {
    const owner = { _id: state._id, lease_token: state.lease_token, batch_id: state.batch_id };
    const current = await deliveries.findOne(owner);
    if (!current) return null;
    if (current.snapshot_id) {
      const chunks = await snapshots.find({ snapshot_id: current.snapshot_id }).toArray();
      const ids = chunks.flatMap((chunk) => chunk.receipt_ids);
      if (ids.length === current.snapshot_size) {
        state.snapshot_revision = current.snapshot_revision;
        return ids;
      }
      // An unpublished window may outlive the recovery journal's TTL during
      // a prolonged outage. Rebuild it only while still holding this claim.
    }
    const rows = await receipts.find(unread, { projection: { _id: 1 } }).toArray();
    const ids = rows.map((row) => row._id);
    if (!ids.length) return [];
    const snapshotID = randomUUID();
    const chunks = [];
    for (let offset = 0; offset < ids.length; offset += 1000) {
      chunks.push({
        _id: snapshotID + ":" + offset,
        snapshot_id: snapshotID,
        receipt_ids: ids.slice(offset, offset + 1000),
        expires_at: new Date(now().getTime() + 7 * 24 * 60 * 60 * 1000),
      });
    }
    await snapshots.insertMany(chunks);
    const frozen = unwrap(await deliveries.findOneAndUpdate({
      ...owner, snapshot_id: current.snapshot_id || null,
    }, { $set: {
      snapshot_id: snapshotID, snapshot_size: ids.length, snapshot_revision: current.revision,
    } }, { returnDocument: "after" }));
    // Coverage is immutable once frozen. An expired worker can only stamp
    // these exact IDs, never activity arriving after another replica saved it.
    if (!frozen) return null;
    state.snapshot_revision = frozen.snapshot_revision;
    return ids;
  }

  async function finish(state, coveredBatch) {
    const finishedAt = now();
    const fields = {
      due_at: null, batch_id: null, snapshot_id: null, snapshot_size: 0, snapshot_revision: null,
      lease_until: null, lease_token: null,
      ...(coveredBatch ? { last_batch_id: coveredBatch, last_sent_at: finishedAt } : {}),
    };
    const result = await deliveries.updateOne({
      _id: state._id, lease_token: state.lease_token,
      revision: state.snapshot_revision ?? state.revision,
    }, { $set: fields });
    if (result.matchedCount) return;
    // An event queued during this flush belongs to a new window. The token
    // prevents an expired worker from finishing another replica's claim.
    await deliveries.updateOne({ _id: state._id, lease_token: state.lease_token }, {
      $set: { ...fields, due_at: new Date(finishedAt.getTime() + COOLDOWN_MS), batch_id: randomUUID() },
      $inc: { generation: 1 },
    });
  }

  async function flushOne() {
    const claimedAt = now();
    const state = unwrap(await deliveries.findOneAndUpdate({
      due_at: { $ne: null, $lte: claimedAt },
      $or: [{ lease_until: null }, { lease_until: { $lte: claimedAt } }],
    }, { $set: { lease_until: new Date(claimedAt.getTime() + LEASE_MS), lease_token: randomUUID() } },
    { returnDocument: "after", sort: { due_at: 1 } }));
    if (!state) return false;
    try {
      if (!(await authorize(state.admin_entity_id, state.community_entity_id))) {
        await finish(state);
        return true;
      }
      const unread = { admin_entity_id: state.admin_entity_id, community_entity_id: state.community_entity_id, is_read: false };
      let preview = await notifications.findOne({ preview_key: state._id, activity_delivery_id: state.batch_id });
      if (!preview) {
        // A retry/late queue update with no newly uncovered activity must not
        // repeatedly replace a preview containing the same unread receipts.
        const fresh = await receipts.countDocuments({ ...unread, preview_id: { $ne: state.last_batch_id || null } });
        // First-window receipts have null preview_id, so all unread are new.
        const pending = state.last_batch_id ? fresh : await receipts.countDocuments(unread);
        if (!pending) {
          await finish(state);
          return true;
        }
        const ids = await freezeReceiptIds(state, unread);
        if (ids === null) return true;
        for (let offset = 0; offset < ids.length; offset += 1000) {
          await receipts.updateMany({
            ...unread,
            _id: { $in: ids.slice(offset, offset + 1000) },
            $or: [{ preview_version: { $exists: false } }, { preview_version: { $lte: state.generation } }],
          }, { $set: { preview_id: state.batch_id, preview_version: state.generation } });
        }
        const count = await receipts.countDocuments({ ...unread, preview_id: state.batch_id });
        if (!count) {
          await finish(state);
          return true;
        }
        const candidate = previewNotification(state, count, claimedAt);
        try {
          await notifications.replaceOne({
            preview_key: state._id,
            $or: [{ activity_delivery_version: { $lt: state.generation } }, { activity_delivery_version: { $exists: false } }],
          }, candidate, { upsert: true });
        } catch (error) {
          // The unique slot also fences a worker whose lease expired while
          // saving. A newer batch always wins; a same-batch retry is immutable.
          if (error.code !== 11000) throw error;
        }
        preview = await notifications.findOne({ preview_key: state._id, activity_delivery_id: state.batch_id });
        if (!preview) {
          await finish(state);
          return true;
        }
      }
      const remaining = await receipts.countDocuments({ ...unread, preview_id: state.batch_id });
      if (!remaining) {
        await notifications.updateOne({ notificationID: preview.notificationID }, { $set: { isRead: true } });
        preview.isRead = true;
      }
      // A read can win after the local snapshot; never reopen that document.
      const current = await notifications.findOne({ notificationID: preview.notificationID });
      if (!current) {
        await finish(state);
        return true;
      }
      await notifications.deleteMany({
        toUserID: state.admin_entity_id,
        community_entity_id: state.community_entity_id,
        type: { $in: [ACTIVITY_TYPE, "community_join_request"] },
        preview_key: { $ne: state._id },
      });
      const message = {
        status: true, auth: true,
        message: "Community activity preview updated",
        result: { type: ACTIVITY_TYPE, realm_id: state.realm_id, community_entity_id: state.community_entity_id },
      };
      await publish("events_" + state.admin_entity_id, current?.isRead ? "notifications_reload" : "notifications", message);
      await publish("events_" + state.admin_entity_id, "community_admin_preview_changed", message);
      // Failed publication leaves the persisted batch retryable with the same
      // ID/count. Completion happens only after both events have been sent.
      await finish(state, state.batch_id);
      return true;
    } catch (error) {
      await deliveries.updateOne({ _id: state._id, lease_token: state.lease_token }, {
        $set: { lease_until: new Date(now().getTime() + POLL_MS), lease_token: null },
      });
      throw error;
    }
  }
  return { flushOne };
}

async function repairPendingReceipts({ deliveries, receipts, now = () => new Date() }) {
  const pending = await receipts.find({ scheduled: false }).limit(100).toArray();
  for (const receipt of pending) {
    if (!receipt.is_read) {
      if (!receipt.delivery_id) continue;
      await deliveries.updateOne({ _id: receipt.delivery_id }, [{ $set: {
        realm_id: { $literal: receipt.realm_id },
        community_entity_id: { $literal: receipt.community_entity_id },
        admin_entity_id: { $literal: receipt.admin_entity_id },
        revision: { $add: [{ $ifNull: ["$revision", 0] }, 1] },
        due_at: { $ifNull: ["$due_at", new Date(now().getTime() + COOLDOWN_MS)] },
        batch_id: { $ifNull: ["$batch_id", randomUUID()] },
        generation: { $cond: [
          { $eq: [{ $ifNull: ["$due_at", null] }, null] },
          { $add: [{ $ifNull: ["$generation", 0] }, 1] },
          "$generation",
        ] },
      } }], { upsert: true });
    }
    await receipts.updateOne({ _id: receipt._id }, { $set: { scheduled: true } });
  }
}

function startCommunityAdminPreviews({ database, client, publish, logger = console }) {
  const deliveries = database.collection("community_admin_deliveries");
  const receipts = database.collection("community_admin_receipts");
  const notifications = database.collection("notifications");
  const snapshots = database.collection("community_admin_preview_snapshots");
  const { canManageCommunityNotifications } = require("../models/communityNotifications");
  const dispatcher = createPreviewDispatcher({ deliveries, receipts, notifications, snapshots,
    authorize: (admin, community) => canManageCommunityNotifications(client, admin, community, undefined, true),
    publish: (channel, event, message) => publish(channel, event, message, { required: true }),
  });
  let running = false;
  let indexed = false;
  async function poll() {
    if (running) return;
    running = true;
    try {
      if (!indexed) {
        await notifications.createIndex({ preview_key: 1 }, { unique: true, sparse: true });
        await notifications.createIndex({ toUserID: 1, community_entity_id: 1, type: 1 });
        await deliveries.createIndex({ due_at: 1, lease_until: 1 });
        await receipts.createIndex({ admin_entity_id: 1, community_entity_id: 1, is_read: 1, preview_id: 1 });
        await receipts.createIndex({ scheduled: 1 });
        await snapshots.createIndex({ snapshot_id: 1 });
        await snapshots.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
        indexed = true;
      }
      await repairPendingReceipts({ deliveries, receipts });
      for (let i = 0; i < 100; i++) {
        try {
          if (!(await dispatcher.flushOne())) break;
        } catch (error) {
          logger.error("[community previews] Delivery will retry:", error.message);
        }
      }
    } catch (error) {
      logger.error("[community previews] Delivery will retry:", error.message);
    } finally {
      running = false;
    }
  }
  const timer = setInterval(poll, POLL_MS);
  timer.unref();
  void poll();
  return () => clearInterval(timer);
}

module.exports = { COOLDOWN_MS, createPreviewDispatcher, repairPendingReceipts, startCommunityAdminPreviews };
