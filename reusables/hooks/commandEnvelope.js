/**
 * What a command handler is given, and how a webhook request is built from it.
 *
 * ONE ENVELOPE, ALL THREE CATEGORIES
 * ----------------------------------
 * A system function, a webhook and a bot all receive the same thing. Handlers
 * differ in what they do, not in what they know, so a category added later
 * needs no new shape - and nothing category-specific leaks into the core.
 *
 * EVERY FIELD IS DERIVED SERVER-SIDE
 * ----------------------------------
 * Nothing here is taken from the sender's payload. That is the same rule
 * send.go follows for `mentioned`, and for the same reason: a client that can
 * name the invoker can invoke as somebody else.
 */

/**
 * The envelope, from what the send path already has in hand.
 */
const buildEnvelope = ({
  command,
  messageID,
  conversationID,
  conversationType,
  sender,
  senderHandle,
  replyingTo,
}) => ({
  command: {
    name: command.name,
    // The raw tail. Not parsed into arguments here: a system function, a model
    // and somebody's webhook all want it differently, and guessing a structure
    // for them would be a structure they each have to undo.
    args: command.args || "",
    target: command.target || null,
  },
  invoker: {
    entity_id: sender,
    handle: senderHandle || "",
  },
  conversation: {
    id: conversationID,
    type: conversationType || "",
  },
  message: {
    id: messageID,
    // The message this command replied to, if any. This is what makes
    // "reply to a media message with /transcribe" work, and it costs nothing:
    // replyingTo is on every message already.
    replying_to: replyingTo || null,
  },
});

/**
 * Substitute {placeholders} in a webhook URL.
 *
 * Values come from the command's STORED definition only, never from the
 * invoker's arguments. A user-supplied value reaching here would be a request
 * forgery: the caller chooses the host, and the host is the whole security
 * boundary of an outbound call.
 *
 * An unknown placeholder is left as written rather than blanked, so a
 * mis-wired command produces a URL somebody can recognise instead of one that
 * silently points somewhere else.
 */
const applyParams = (url, params = {}) =>
  String(url || "").replace(/\{([A-Za-z0-9_]+)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(params || {}, key)
      ? encodeURIComponent(String(params[key]))
      : whole,
  );

/**
 * The outbound request for a webhook command.
 *
 * `webhook_request` holds four optional parts, all from the stored definition:
 *
 *   params   substituted into {placeholders} in the URL
 *   query    appended to the query string
 *   headers  added to the request
 *   payload  merged into the body ALONGSIDE the envelope
 *
 * The envelope wins on a key collision. A definition that could overwrite
 * `invoker` would be a way to make a request claim it came from someone else,
 * which is exactly what deriving the envelope server-side was for.
 */
const buildWebhookRequest = (row, envelope) => {
  const request = row.webhook_request || {};
  const params = request.params || {};
  const query = request.query || {};
  const headers = request.headers || {};
  const payload = request.payload || {};

  const url = new URL(applyParams(row.webhook_url, params));
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(String(key), String(value));
  }

  return {
    url: url.toString(),
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [String(k), String(v)]),
      ),
    },
    // Spread payload FIRST so the envelope cannot be overwritten by it.
    body: { ...payload, ...envelope },
  };
};

module.exports = { buildEnvelope, buildWebhookRequest, applyParams };
