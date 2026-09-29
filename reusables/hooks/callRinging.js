// End-of-call missed-call notices for direct and group calls.
//
// Event-driven on purpose - nothing here runs on a timer. /call writes who it
// rang (redis/pubsub.js markInvited); joining or declining takes a person off
// that list; and when the call's room empties, whoever is still on it never
// joined and gets a missed call. The ring itself stops on the phone after 45s
// with no help from the server.

const push = require("./pushnotification");
const { CallMissedNotif } = require("./sse");
const { drainInvited } = require("../redis/pubsub");

/**
 * The room for [conversationID] just emptied: the call is over. Sends a missed
 * call to everyone it rang who never joined.
 *
 * Called on EVERY room that empties, voice channels included - those were
 * never rung, so there is no invite list and this is one Redis round trip
 * that finds nothing.
 */
async function ringOut(conversationID) {
  const { invited, meta } = await drainInvited(conversationID);
  if (invited.length === 0 || !meta) return;

  // Push reaches devices with no live connection; the SSE twin reaches the
  // rest. The worker never pushes to an online device, so no device gets
  // both.
  push.sendMissedCall({ receivers: invited, callMetadata: meta });
  const missedData = push.missedCallData(meta);
  invited.forEach((entityID) => CallMissedNotif(entityID, missedData));
}

module.exports = { ringOut };
