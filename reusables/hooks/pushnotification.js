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
const CHANNEL_CALLS = "chatterloop_calls_v2";

// How long FCM may hold an undelivered ring before discarding it. A ring that
// arrives after the call is over is worse than none, and the app gives up
// ringing at 45s anyway.
const CALL_RING_TTL_SEC = 30;

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
   * Targets either [entityIDs] - the worker resolves their offline devices,
   * or every device with [allDevices] - or an explicit [tokens] list, which
   * skips resolution.
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
    // 0 leaves FCM's default (up to four weeks). Set it for anything that is
    // pointless late - a ring, a ring's cancellation.
    ttlSeconds = 0,
    // Push to online devices too, not only offline ones. For calls: an app
    // Android has frozen in the background still holds its live connection
    // open, so it counts as online - and would never hear its phone ring.
    // The app drops whichever of the push and the live event comes second.
    allDevices = false,
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
      ttl_seconds: Math.max(0, Math.floor(Number(ttlSeconds) || 0)),
      all_devices: !!allDevices,
      data: stringData,
    });
  }

  /**
   * An incoming direct or group call, rung on the Calls channel until it is
   * answered, declined, cancelled or 45s pass.
   *
   * [callMetadata] is the caller's own /call token payload - the same object
   * the `incomingcall` SSE relays - so the push and the live alert can't
   * describe the call differently. Flattened here because FCM data is
   * string-only; `recepients` travels as JSON.
   */
  async sendCall({ receivers = [], callMetadata, ringStartedAt = Date.now() }) {
    const isGroup = callMetadata.conversationType !== "single";
    const kind = callMetadata.callType === "video" ? "video call" : "voice call";
    const callerName = callMetadata.caller?.name || "";
    return this.send({
      entityIDs: receivers,
      channelId: CHANNEL_CALLS,
      tag: `call:${callMetadata.conversationID}`,
      ttlSeconds: CALL_RING_TTL_SEC,
      allDevices: true,
      title: callMetadata.callDisplayName,
      body: isGroup ? `${callerName} is calling · ${kind}` : `Incoming ${kind}`,
      data: {
        type: "call",
        conversationID: callMetadata.conversationID,
        conversationType: callMetadata.conversationType,
        callType: callMetadata.callType,
        callDisplayName: callMetadata.callDisplayName,
        callerName,
        callerEntityID: callMetadata.caller?.entityID,
        recepients: JSON.stringify(callMetadata.recepients || []),
        displayImage:
          callMetadata.displayImage && callMetadata.displayImage !== "none"
            ? callMetadata.displayImage
            : "",
        title: callMetadata.callDisplayName,
        body: isGroup ? `${callerName} is calling · ${kind}` : `Incoming ${kind}`,
        // The app stops ringing 45s after THIS, not after arrival, so a push
        // that sat in FCM for 20s rings for the remaining 25.
        sentAt: String(ringStartedAt),
      },
    });
  }

  /**
   * Takes a ring back silently: the app removes the call notification for
   * [conversationID]. For a callee's OTHER devices once one of them answers
   * or declines - they acted on it, so there is nothing to tell them.
   */
  async cancelCall({ receivers = [], conversationID }) {
    return this.send({
      entityIDs: receivers,
      channelId: CHANNEL_CALLS,
      ttlSeconds: CALL_RING_TTL_SEC * 2,
      allDevices: true,
      data: { type: "call_cancel", conversationID },
    });
  }

  /**
   * The call ENDED - its room emptied - and [receivers] never joined it: a
   * direct call the caller hung up unanswered, or a group call however many
   * others took part. See callRinging.js.
   *
   * The app replaces the ring, if it is somehow still up, with a "Missed
   * call" on the quieter Activity channel. The shared `tag` lets an
   * OS-rendered ring (the future iOS path) be replaced the same way, since
   * iOS can only replace a notification, never remove one.
   *
   * No TTL, unlike the ring: a device that was off for an hour should still
   * learn it missed a call.
   */
  async sendMissedCall({ receivers = [], callMetadata }) {
    const data = missedCallData(callMetadata);
    return this.send({
      entityIDs: receivers,
      channelId: CHANNEL_ACTIVITY,
      tag: `call:${callMetadata.conversationID}`,
      title: data.title,
      body: data.body,
      allDevices: true,
      data,
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
        // /notifications /profile /settings /post/ /moments/ /server/
        route,
        imageUrl,
        senderAvatarUrl,
      },
    });
  }
}

/**
 * What a missed call says, and where tapping it goes - built once so the
 * push and the `callmissed` SSE (sse.js) are the same notice.
 */
function missedCallData(callMetadata) {
  const isGroup = callMetadata.conversationType !== "single";
  const kind = callMetadata.callType === "video" ? "video call" : "voice call";
  const callerName = callMetadata.caller?.name || "";
  return {
    type: "call_missed",
    conversationID: callMetadata.conversationID,
    title: callMetadata.callDisplayName || callerName || "Missed call",
    body: isGroup && callerName ? `Missed ${kind} from ${callerName}` : `Missed ${kind}`,
    route: `/conversation/${callMetadata.conversationID}`,
    senderAvatarUrl:
      callMetadata.displayImage && callMetadata.displayImage !== "none"
        ? callMetadata.displayImage
        : "",
    // Lets the app drop the notice for someone who hit Decline on the ring -
    // that Decline is local only, so the server can't know. See
    // NotificationRenderer's decline marker.
    ringStartedAt: callMetadata.ringStartedAt
      ? String(callMetadata.ringStartedAt)
      : "",
  };
}

// Single shared instance - there's no per-caller state worth duplicating.
module.exports = new PushNotification();
module.exports.PushNotification = PushNotification;
module.exports.missedCallData = missedCallData;
