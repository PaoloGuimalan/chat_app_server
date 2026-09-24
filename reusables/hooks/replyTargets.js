/**
 * What a message is replying to, and the card the client draws for it.
 *
 * `replyingTo` on a message is written as ONE shape:
 *
 *   { type: "message"|"post"|"moment"|"thought", id }
 *
 * whatever the client sent - sanitizeIncomingReplyingTo turns a bare id into
 * {type: "message", id}, and developer_service writes bot replies the same
 * way. Rows stored before this still hold the bare id string, so every READER
 * goes through normalizeReplyTarget, which treats a bare string as a message
 * id. Nothing should branch on the stored shape by hand.
 *
 * On the WIRE, `replyingTo` stays what clients have always received - a
 * message id or "" (legacyReplyingTo) - so installed app builds are untouched;
 * the type travels in `replyedtarget`.
 *
 * hydrateReplyTargets then gives every reply on a page one `replyedtarget`
 * field, the same shape whatever the type:
 *
 *   { type, id, status: "active" | "expired" | "unavailable",
 *     author: { entity_id, type, display_name, handle, profile } | null,
 *     content: {...} }   // omitted unless there is something to show
 *
 * `replyedmessage` (the $lookup result, see REPLIED_MESSAGE_LOOKUP) is kept
 * for message replies, so a client that has not moved to replyedtarget still
 * renders them.
 */

const pool = require("../database/postgres");
const { GetEntityHandles } = require("../models/users");
const { POST_KINDS, postVisibleToSQL } = require("../models/posts");

const REPLY_TARGET_TYPES = Object.freeze({
  MESSAGE: "message",
  // A feed post is "post" here, not its on_feed value "feed": this names what
  // the reply points at, and "replied to a feed" is not a thing.
  POST: "post",
  MOMENT: POST_KINDS.MOMENT,
  THOUGHT: POST_KINDS.THOUGHT,
});

// Every type a stored {type, id} may carry.
const OBJECT_TARGET_TYPES = new Set([
  REPLY_TARGET_TYPES.MESSAGE,
  REPLY_TARGET_TYPES.POST,
  REPLY_TARGET_TYPES.MOMENT,
  REPLY_TARGET_TYPES.THOUGHT,
]);

/**
 * The aggregation stage that fills `replyedmessage` - the message a reply
 * points at - for either stored shape: a bare id (older rows) or
 * {type: "message", id}. A reply to a post/moment/thought resolves to no
 * message, which is correct; hydrateReplyTargets handles those.
 *
 * Replaces a plain `localField: "replyingTo"` lookup, which can only match the
 * bare-string shape - every reply written as {type, id} would have come back
 * with no quoted message.
 */
const REPLIED_MESSAGE_LOOKUP = Object.freeze({
  $lookup: {
    from: "messages",
    let: {
      repliedID: {
        $cond: [
          { $eq: [{ $type: "$replyingTo" }, "string"] },
          "$replyingTo",
          {
            $cond: [
              { $eq: ["$replyingTo.type", REPLY_TARGET_TYPES.MESSAGE] },
              "$replyingTo.id",
              null,
            ],
          },
        ],
      },
    },
    pipeline: [
      {
        $match: {
          $expr: {
            $and: [
              { $gt: ["$$repliedID", ""] },
              { $eq: ["$messageID", "$$repliedID"] },
            ],
          },
        },
      },
      { $limit: 1 },
    ],
    as: "replyedmessage",
  },
});

/**
 * `replyingTo` AS CLIENTS HAVE ALWAYS RECEIVED IT: the replied-to MESSAGE id,
 * or "" - never the stored object.
 *
 * Storage is {type, id}; the wire is not, so every chatterloop_app build
 * already installed keeps reading replies exactly as before (it reads
 * `replyingTo` as a string and draws the quote from `replyedmessage`). A reply
 * to a post, moment or thought goes out as "" - to an old build, a reply whose
 * quote it cannot draw, which it already handles. New clients read the type
 * from `replyedtarget`, which carries {type, id}.
 *
 * legacyReplyingTo is for a message already in hand; LEGACY_REPLYING_TO_EXPR
 * is the same rule as an aggregation expression, for the conversation lists'
 * `$last: "$replyingTo"`.
 */
const legacyReplyingTo = (replyingTo) => {
  const target = normalizeReplyTarget(replyingTo);
  return target && target.type === REPLY_TARGET_TYPES.MESSAGE ? target.id : "";
};

const LEGACY_REPLYING_TO_EXPR = Object.freeze({
  $cond: [
    { $eq: [{ $type: "$replyingTo" }, "object"] },
    {
      $cond: [
        { $eq: ["$replyingTo.type", REPLY_TARGET_TYPES.MESSAGE] },
        "$replyingTo.id",
        "",
      ],
    },
    { $ifNull: ["$replyingTo", ""] },
  ],
});

// A card shows a line or two, not the whole caption.
const CARD_TEXT_LIMIT = 120;

const clip = (text) => {
  const chars = [...String(text || "")];
  return chars.length > CARD_TEXT_LIMIT
    ? `${chars.slice(0, CARD_TEXT_LIMIT).join("")}…`
    : chars.join("");
};

/**
 * {type, id} for any stored replyingTo, or null when it replies to nothing.
 */
const normalizeReplyTarget = (replyingTo) => {
  if (!replyingTo) return null;
  if (typeof replyingTo === "string") {
    return { type: REPLY_TARGET_TYPES.MESSAGE, id: replyingTo };
  }
  if (typeof replyingTo === "object" && replyingTo.type && replyingTo.id) {
    return { type: String(replyingTo.type), id: String(replyingTo.id) };
  }
  return null;
};

/**
 * What to store for the replyingTo a client sent: "" for no reply, otherwise
 * always {type, id}. A bare string - what every client sends for a message
 * reply today - is a message id and becomes {type: "message", id}. Throws on
 * anything else, so a malformed object never reaches Mongo.
 */
const sanitizeIncomingReplyingTo = (replyingTo) => {
  if (replyingTo === undefined || replyingTo === null || replyingTo === "") {
    return "";
  }
  if (typeof replyingTo === "string") {
    return { type: REPLY_TARGET_TYPES.MESSAGE, id: replyingTo };
  }

  if (
    typeof replyingTo === "object" &&
    OBJECT_TARGET_TYPES.has(replyingTo.type) &&
    typeof replyingTo.id === "string" &&
    replyingTo.id
  ) {
    return { type: replyingTo.type, id: replyingTo.id };
  }

  throw new Error("Invalid replyingTo");
};

/**
 * Refuses a reply to a post, moment or thought the sender may not reply to:
 * one that does not exist or is deleted, one they cannot see, a moment or
 * thought that has expired, or one whose author turned replies off
 * (details.allow_replies). Message replies are not checked here - the
 * conversation membership check already covers them.
 *
 * Throws an Error whose message is safe to show; resolves quietly otherwise.
 */
const assertCanReplyTo = async (replyingTo, senderEntityID) => {
  const target = normalizeReplyTarget(replyingTo);
  if (!target || target.type === REPLY_TARGET_TYPES.MESSAGE) return;

  const { rows } = await pool.query(
    `
    SELECT
      p.on_feed,
      p.expires_at IS NOT NULL AND p.expires_at <= now() AS is_expired,
      COALESCE(p.details ->> 'allow_replies', 'true') <> 'false' AS allows_replies
    FROM newsfeed_post p
    WHERE p.post_id = $1
      AND p.deleted_at IS NULL
      AND ${postVisibleToSQL("p", "$2")}
    LIMIT 1;
    `,
    [target.id, String(senderEntityID)],
  );

  const row = rows[0];
  if (!row) throw new Error(`That ${target.type} is not available`);
  if (row.is_expired) throw new Error(`That ${target.type} has expired`);
  if (row.on_feed !== "feed" && !row.allows_replies) {
    throw new Error(`Replies are turned off for this ${target.type}`);
  }
};

/**
 * The message id a reply points at, or null when it is not a message reply.
 * For the readers that only understand message threading (the command
 * envelope, bots).
 */
const repliedMessageID = (replyingTo) => {
  const target = normalizeReplyTarget(replyingTo);
  return target && target.type === REPLY_TARGET_TYPES.MESSAGE
    ? target.id
    : null;
};

const PREVIEW_LABELS = {
  [REPLY_TARGET_TYPES.POST]: "Sent a post",
  [REPLY_TARGET_TYPES.MOMENT]: "Replied to a moment",
  [REPLY_TARGET_TYPES.THOUGHT]: "Replied to a thought",
};

/**
 * One line standing in for a message with no text of its own - a post sent
 * into a chat without a note. Used for the conversation list's last message
 * and the push body, which would otherwise be empty. Null for a message reply
 * (it always has text) and for anything that is not a reply.
 */
const replyPreviewLabel = (replyingTo) => {
  const target = normalizeReplyTarget(replyingTo);
  return (target && PREVIEW_LABELS[target.type]) || null;
};

const authorCard = (entityID, handles) => {
  const found = handles.get(String(entityID));
  if (!found) return null;
  return {
    entity_id: String(entityID),
    type: found.entity_type,
    display_name: found.display_name || found.handle || "",
    handle: found.handle || "",
    profile: found.profile || null,
  };
};

/**
 * Every post, moment and thought on the page in ONE query, with whether the
 * viewer may see it computed in the same statement.
 *
 * Deliberately NOT filtered by kind or expiry: an expired moment still has to
 * come back so the card can say "expired" and name its author.
 */
const loadPostTargets = async (postIDs, viewerEntityID) => {
  if (!postIDs.length) return new Map();

  const { rows } = await pool.query(
    `
    SELECT
      p.post_id,
      p.entity_id,
      p.on_feed,
      p.caption,
      p.file_type,
      p.is_archived,
      p.deleted_at IS NOT NULL AS is_deleted,
      p.expires_at,
      p.expires_at IS NOT NULL AND p.expires_at <= now() AS is_expired,
      ${postVisibleToSQL("p", "$2")} AS can_view,
      ref.reference,
      ref.reference_media_type
    FROM newsfeed_post p
    LEFT JOIN LATERAL (
      SELECT r.reference, r.reference_media_type
      FROM newsfeed_postreference r
      WHERE r.post_id = p.post_id
      ORDER BY r.reference_id
      LIMIT 1
    ) ref ON TRUE
    WHERE p.post_id = ANY($1::text[]);
    `,
    [postIDs, String(viewerEntityID)],
  );

  return new Map(rows.map((row) => [String(row.post_id), row]));
};

// The card for a post / moment / thought row, as `viewerEntityID` sees it.
const postTargetCard = (target, row, handles, viewerEntityID) => {
  if (!row || row.is_deleted) {
    return { ...target, status: "unavailable", author: null };
  }

  // The row's own kind wins over the type the client wrote, so a reply that
  // claims a feed post is a "moment" cannot borrow a moment's rules.
  const kind = row.on_feed;
  const type =
    kind === POST_KINDS.MOMENT || kind === POST_KINDS.THOUGHT ? kind : "post";
  const author = authorCard(row.entity_id, handles);
  const isAuthor = String(row.entity_id) === String(viewerEntityID);

  // Archiving hides a post from everyone but its author - same as the
  // preview page does.
  if (!row.can_view || (row.is_archived && !isAuthor)) {
    return { type, id: target.id, status: "unavailable", author };
  }

  const expiresAt = row.expires_at ? new Date(row.expires_at).toISOString() : null;

  if (row.is_expired) {
    return {
      type,
      id: target.id,
      status: "expired",
      author,
      content: { expires_at: expiresAt },
    };
  }

  const isShare = row.file_type === "shared_post";
  const mediaType = isShare ? null : row.reference_media_type || null;
  const thumbnail = isShare ? null : row.reference || null;

  let content;
  if (type === POST_KINDS.THOUGHT) {
    content = { text: row.caption || "", expires_at: expiresAt };
  } else if (type === POST_KINDS.MOMENT) {
    content = {
      thumbnail,
      media_type: mediaType,
      caption: clip(row.caption),
      expires_at: expiresAt,
    };
  } else {
    content = {
      caption: clip(row.caption),
      thumbnail,
      media_type: mediaType,
      file_type: row.file_type,
      // A share's single reference is the ORIGINAL post's id, not media.
      shared_post_id: isShare ? row.reference || null : null,
    };
  }

  return { type, id: target.id, status: "active", author, content };
};

// The card for a message reply, from the $lookup the route already ran.
const messageTargetCard = (target, repliedMessage, handles) => {
  if (!repliedMessage) {
    return { ...target, status: "unavailable", author: null };
  }

  const author = authorCard(repliedMessage.sender, handles);
  if (repliedMessage.isDeleted) {
    return { ...target, status: "unavailable", author };
  }

  const messageType = String(repliedMessage.messageType || "text");
  const content =
    messageType === "text" || messageType === "notif"
      ? { message_type: messageType, text: clip(repliedMessage.content) }
      : { message_type: messageType, url: repliedMessage.content || null };

  return { ...target, status: "active", author, content };
};

/**
 * Sets `replyedtarget` on every reply in `messages` (mutated in place, and
 * returned). Two round trips for the whole page at most: one for every
 * post-like target, one for every author.
 *
 * Message replies read the `replyedmessage` array the aggregation already
 * produced, so no extra Mongo query is made for them.
 */
const hydrateReplyTargets = async (messages, viewerEntityID) => {
  const replies = messages
    .map((message) => ({
      message,
      target: message.isReply ? normalizeReplyTarget(message.replyingTo) : null,
    }))
    .filter(({ target }) => target);

  if (!replies.length) return messages;

  const postIDs = [
    ...new Set(
      replies
        .filter(({ target }) => target.type !== REPLY_TARGET_TYPES.MESSAGE)
        .map(({ target }) => target.id),
    ),
  ];

  let posts = new Map();
  try {
    posts = await loadPostTargets(postIDs, viewerEntityID);
  } catch (err) {
    // A failed lookup degrades to "unavailable" cards, never to a failed
    // conversation load.
    console.log("[replyTargets] post lookup failed:", err.message || err);
  }

  const authorIDs = new Set();
  for (const { message, target } of replies) {
    if (target.type === REPLY_TARGET_TYPES.MESSAGE) {
      const replied = message.replyedmessage?.[0];
      if (replied?.sender) authorIDs.add(String(replied.sender));
    } else {
      const row = posts.get(target.id);
      if (row) authorIDs.add(String(row.entity_id));
    }
  }

  let handles = new Map();
  try {
    handles = await GetEntityHandles([...authorIDs]);
  } catch (err) {
    console.log("[replyTargets] author lookup failed:", err.message || err);
  }

  for (const { message, target } of replies) {
    message.replyedtarget =
      target.type === REPLY_TARGET_TYPES.MESSAGE
        ? messageTargetCard(target, message.replyedmessage?.[0], handles)
        : postTargetCard(target, posts.get(target.id), handles, viewerEntityID);
  }

  return messages;
};

module.exports = {
  REPLY_TARGET_TYPES,
  REPLIED_MESSAGE_LOOKUP,
  LEGACY_REPLYING_TO_EXPR,
  legacyReplyingTo,
  normalizeReplyTarget,
  sanitizeIncomingReplyingTo,
  assertCanReplyTo,
  repliedMessageID,
  replyPreviewLabel,
  hydrateReplyTargets,
};
