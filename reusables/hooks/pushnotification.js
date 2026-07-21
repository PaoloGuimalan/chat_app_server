require("dotenv").config();
const firebase = require("firebase-admin");

// Side-effect require: firebaseupload.js OWNS the default Firebase app.
//
// Two reasons this file must not create one itself. First, initializeApp
// throws outright on a second call - "already exists and initializeApp was
// invoked with an optional Credential" - so whichever module loads second
// crashes the process, and load order depends on which route Node reaches
// first. Second, and worse if it were only guarded: firebaseupload
// initializes WITH storageBucket. An app created here would lack it, and
// every upload would silently lose its default bucket.
//
// Requiring it makes the dependency one-directional and the order irrelevant:
// firebaseupload is always the creator, this file is always a consumer.
require("./firebaseupload");

const UserSessions = require("../../schema/auth/sessions");
const Conversation = require("../../schema/messages/conversation");

// Channel ids and sound names must match the mobile app exactly
// (chatterloop_app/lib/core/notifications/notification_renderer.dart). The _v2
// suffix is not cosmetic: a channel's sound and importance are locked at
// creation, so giving the channels custom tones required new ids.
const CHANNEL_MESSAGES = "chatterloop_messages_v2";
const CHANNEL_ACTIVITY = "chatterloop_activity_v2";
const SOUND_MESSAGES = "message_alert";
const SOUND_ACTIVITY = "notification_alert";

// sendEachForMulticast caps at 500 tokens per call.
const MAX_TOKENS_PER_SEND = 500;

// Error codes that mean the token is dead rather than the send being wrong.
const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

/**
 * Reusable push sender for every kind of alert.
 *
 * Two payload shapes, matching what the mobile app expects
 * (chatterloop_app/lib/core/notifications/push_payload.dart):
 *
 *   sendMessage()  -> type "message", rendered as a threaded conversation
 *                     notification (avatar, stacked messages, own section).
 *   sendActivity() -> any other type, rendered as a single title/body card on
 *                     the quieter Activity channel.
 *
 * Both send DATA-ONLY by default. That is deliberate, not an oversight: a
 * `notification` block makes Android render the push itself while the app is
 * backgrounded, which skips the app's renderer entirely and loses the threaded
 * layout, the avatars and the per-conversation grouping. Pass
 * `osRendered: true` to opt into the plain OS-rendered shape - useful as a
 * fallback if an OEM's battery management turns out to suppress the app's
 * background isolate.
 */
class PushNotification {
  constructor() {
    // Already guaranteed to exist by the require above.
    this.app = firebase.app();
  }

  // ─── targeting ────────────────────────────────────────────────────────────

  /**
   * FCM tokens for the devices that will NOT receive this over SSE.
   *
   *   status === false -> no live SSE connection, so SSE can't deliver it
   *   fcmToken != null -> still signed in there (logout and entity switch both
   *                       null it, so a null token means "not a target")
   *
   * Devices with status true already get the event over SSE; pushing to them
   * as well is what produces duplicate notifications.
   */
  async offlineTokensFor(entityIDs = []) {
    const ids = (Array.isArray(entityIDs) ? entityIDs : [entityIDs])
      .filter(Boolean)
      .map(String);
    if (!ids.length) return [];

    const rows = await UserSessions.find(
      {
        entityID: { $in: ids },
        status: false,
        fcmToken: { $nin: [null, ""] },
      },
      { fcmToken: 1 },
    ).lean();

    // One physical device can hold session rows for several entities (personal
    // plus each page it can act as), so dedupe or it gets notified twice.
    return [...new Set(rows.map((r) => r.fcmToken))];
  }

  /** Participant entity ids for a conversation, minus [excludeEntityID]. */
  async participantsOf(conversationID, excludeEntityID = null) {
    const convo = await Conversation.findOne(
      { conversationID },
      { participant_ids: 1 },
    ).lean();
    if (!convo) return [];
    return (convo.participant_ids || [])
      .filter(Boolean)
      .filter((id) => String(id) !== String(excludeEntityID));
  }

  /** Clears tokens FCM has told us are dead, so they stop being targets. */
  async pruneTokens(tokens = []) {
    if (!tokens.length) return;
    await UserSessions.updateMany(
      { fcmToken: { $in: tokens } },
      { $set: { fcmToken: null } },
    );
  }

  // ─── sending ──────────────────────────────────────────────────────────────

  /**
   * Low-level send. Prefer sendMessage/sendActivity; this is the escape hatch
   * for a shape they don't cover.
   *
   * Resolves either from [entityIDs] (looked up through offlineTokensFor) or
   * from an explicit [tokens] list, which is mainly useful for testing.
   */
  async send({
    entityIDs = null,
    tokens = null,
    data = {},
    channelId = CHANNEL_ACTIVITY,
    sound = SOUND_ACTIVITY,
    osRendered = false,
    title = "",
    body = "",
    tag = null,
    imageUrl = null,
  }) {
    try {
      const targets = tokens || (await this.offlineTokensFor(entityIDs || []));
      // sendEachForMulticast throws on an empty tokens array rather than
      // returning an empty result, so this guard is required, not defensive.
      if (!targets.length) return { successCount: 0, failureCount: 0 };

      const payload = {
        // Every value must be a STRING and non-null: FCM rejects the whole
        // message otherwise, not just the offending field. Empty values are
        // dropped rather than sent as "".
        data: Object.fromEntries(
          Object.entries(data)
            .filter(([, v]) => v !== null && v !== undefined && v !== "")
            .map(([k, v]) => [k, String(v)]),
        ),
        android: {
          // Normal priority gets batched by Doze and can arrive minutes late,
          // which for a chat notification reads as "push is broken".
          priority: "high",
        },
      };

      if (osRendered) {
        payload.notification = { title, body };
        payload.android.notification = {
          channelId,
          sound,
          // Successive pushes with the same tag replace one another instead of
          // stacking - the one bit of per-conversation grouping available
          // without the app doing the rendering.
          ...(tag ? { tag: String(tag) } : {}),
          ...(imageUrl ? { imageUrl: String(imageUrl) } : {}),
        };
      }

      let successCount = 0;
      let failureCount = 0;
      const dead = [];

      for (let i = 0; i < targets.length; i += MAX_TOKENS_PER_SEND) {
        const chunk = targets.slice(i, i + MAX_TOKENS_PER_SEND);
        const response = await firebase
          .messaging()
          .sendEachForMulticast({ ...payload, tokens: chunk });

        successCount += response.successCount;
        failureCount += response.failureCount;

        response.responses.forEach((r, index) => {
          if (!r.success && DEAD_TOKEN_CODES.has(r.error?.code)) {
            dead.push(chunk[index]);
          }
        });
      }

      await this.pruneTokens(dead);
      return { successCount, failureCount, pruned: dead.length };
    } catch (err) {
      // Never throw into a request path - a failed push must not fail the
      // message that triggered it.
      console.log("[push] send failed:", err.message);
      return { successCount: 0, failureCount: 0, error: err.message };
    }
  }

  /**
   * A new chat message. Renders as a threaded conversation notification.
   *
   * [conversationId] must be the REAL conversationID: the app uses it as the
   * Android shortcut id, so a wrong value silently costs the conversation
   * layout (big avatar, app-icon badge, Conversations section).
   *
   * [receivers] should already exclude the sender - GetAllReceivers includes
   * them, and nobody wants to be notified of their own message.
   */
  async sendMessage({
    receivers = [],
    conversationId,
    conversationName = "",
    isGroup = false,
    senderId = "",
    senderName = "",
    senderAvatarUrl = "",
    body = "",
    messageId = "",
    osRendered = false,
  }) {
    const preview = body || "Sent a message";
    return this.send({
      entityIDs: receivers,
      channelId: CHANNEL_MESSAGES,
      sound: SOUND_MESSAGES,
      osRendered,
      tag: conversationId,
      // Only consulted when osRendered - the app builds its own text
      // otherwise. Single chats title on the sender, groups on the group with
      // the sender folded into the body.
      title: isGroup ? conversationName : senderName,
      body: isGroup ? `${senderName}: ${preview}` : preview,
      data: {
        type: "message",
        conversationId,
        conversationName,
        isGroup: String(Boolean(isGroup)),
        senderId,
        senderName,
        senderAvatarUrl,
        body: preview,
        // ms since epoch: the app shows this as the per-message timestamp
        // inside a thread, so it must be the SENT time or a burst of queued
        // pushes all read as "now".
        sentAt: String(Date.now()),
        messageId,
      },
    });
  }

  /**
   * Anything that isn't a chat message - contact requests, reactions,
   * mentions, follows, system notices.
   *
   * The app renders these generically: it reads only title, body and the
   * optional route/image fields, never [type]. A brand-new alert type
   * therefore displays and deep-links correctly with no mobile release, so
   * [type] is free-form and exists for your own logging and analytics.
   *
   * Thumbnail is content-driven and blank when neither image is supplied:
   *   imageUrl        -> square, for content (a post that was liked)
   *   senderAvatarUrl -> circular, for person-centric events
   */
  async sendActivity({
    receivers = [],
    type = "activity",
    title = "",
    body = "",
    route = "",
    imageUrl = "",
    senderAvatarUrl = "",
    osRendered = false,
  }) {
    return this.send({
      entityIDs: receivers,
      channelId: CHANNEL_ACTIVITY,
      sound: SOUND_ACTIVITY,
      osRendered,
      title,
      body,
      imageUrl,
      data: {
        type,
        title,
        body,
        // Only these prefixes are honoured by the app; anything else falls
        // back to the notifications screen: /conversation/ /user/ /realm/
        // /notifications /profile /settings
        route,
        imageUrl,
        senderAvatarUrl,
      },
    });
  }
}

// Single shared instance - the constructor resolves the Firebase app, and
// there's no per-caller state worth duplicating.
module.exports = new PushNotification();
module.exports.PushNotification = PushNotification;
