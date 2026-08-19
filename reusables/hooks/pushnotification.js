require("dotenv").config();

const Conversation = require("../../schema/messages/conversation");
const { publish, QUEUES } = require("../rabbitmq/workqueue");

// Channel ids and sound names must match the mobile app exactly
// (chatterloop_app/lib/core/notifications/notification_renderer.dart). The _v2
// suffix is not cosmetic: a channel's sound and importance are locked at
// creation, so giving the channels custom tones required new ids.
//
// Kept in step with the same constants in the worker
// (worker_service/internal/services/rabbitmq/push.go).
const CHANNEL_MESSAGES = "chatterloop_messages_v2";
const CHANNEL_ACTIVITY = "chatterloop_activity_v2";

/**
 * Reusable push sender for every kind of alert.
 *
 * Sending now happens in the Go worker: it resolves which devices are offline,
 * talks to FCM, and retires the tokens FCM rejects. Everything below is the
 * PUBLISHER, and its job is only to describe the notification.
 *
 * Nothing about the two payload shapes changed, because the mobile app reads
 * them (chatterloop_app/lib/core/notifications/push_payload.dart):
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
 *
 * ADDING A NEW NOTIFICATION TYPE needs nothing here: call send() with a
 * channel, a title/body and whatever `data` the client should route on. The
 * worker never branches on type.
 */
class PushNotification {
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

  /**
   * Low-level publish. Prefer sendMessage/sendActivity; this is the escape
   * hatch for a shape they don't cover, and the entry point for any future
   * notification type.
   *
   * Targets either [entityIDs] - the worker resolves their offline devices -
   * or an explicit [tokens] list, which skips resolution.
   */
  async send({
    entityIDs = null,
    tokens = null,
    data = {},
    channelId = CHANNEL_ACTIVITY,
    osRendered = false,
    title = "",
    body = "",
    tag = null,
    imageUrl = null,
  }) {
    const receivers = (Array.isArray(entityIDs) ? entityIDs : [entityIDs])
      .filter(Boolean)
      .map(String);

    // Nothing to address it to. Worth stopping here rather than publishing a
    // job the worker can only discard.
    if (receivers.length === 0 && (!tokens || tokens.length === 0)) {
      return false;
    }

    // Every value must be a STRING and non-null: FCM rejects the whole message
    // otherwise, not just the offending field. Empty values are dropped rather
    // than sent as "".
    const stringData = Object.fromEntries(
      Object.entries(data)
        .filter(([, value]) => value !== null && value !== undefined && value !== "")
        .map(([key, value]) => [key, String(value)]),
    );

    return publish(QUEUES.SEND_PUSH, {
      entity_ids: receivers,
      tokens: tokens || [],
      channel: channelId,
      title: title,
      body: body,
      tag: tag ? String(tag) : "",
      image_url: imageUrl ? String(imageUrl) : "",
      os_rendered: !!osRendered,
      data: stringData,
    });
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
        // inside a thread. Stamped HERE rather than in the worker, so a
        // backlog of queued pushes keeps each message's real sent time
        // instead of all reading "now".
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

// Single shared instance - there's no per-caller state worth duplicating.
module.exports = new PushNotification();
module.exports.PushNotification = PushNotification;
