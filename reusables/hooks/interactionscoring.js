const { bumpLock } = require("../redis/pubsub");
const { publish, QUEUES } = require("../rabbitmq/workqueue");

// The weights themselves now live in the worker
// (worker_service/internal/services/rabbitmq/handlers.go). Kept here only as
// the vocabulary this service is allowed to send: an action the worker does not
// know returns at its weight lookup having silently done nothing, so a typo
// here is invisible rather than loud.
const INTERACTION_ACTIONS = new Set([
  "NEW_CONNECTION",
  "SHARE",
  "REPOST",
  "CHAT",
  "COMMENT",
  "LIKE",
  "VIEW",
  "PROFILE_VISIT",
]);

/**
 * Hands an interaction bump to the worker, which owns the Postgres write.
 */
const interactionScoreBump = async (
  actorID,
  receiverID,
  action,
  isDecrease,
) => {
  if (actorID === receiverID) return;

  if (!INTERACTION_ACTIONS.has(action)) {
    console.log(`[interactionScoreBump] unknown action ignored: ${action}`);
    return;
  }

  await publish(QUEUES.INTERACTION_SCORE_BUMP, {
    actor_id: actorID,
    receiver_id: receiverID,
    action: action,
    is_decrease: !!isDecrease,
  });
};

/**
 * Bump the actor against everyone else in a conversation.
 *
 * ONE message carrying the whole member list, not one per member: the handler
 * resolves them in a single UPDATE, so a 40-person group chat costs one publish
 * and one statement rather than 40 of each.
 *
 * The lock STAYS here. It is what makes this one bump per conversation per 30
 * minutes rather than one per message, and the worker has no idea a
 * conversation exists - publishing unguarded would bump on every message sent.
 *
 * The actor and duplicates are dropped handler-side, so callers can pass the
 * participant list straight through.
 */
const bumpChatScore = async (conversationID, memberIDs, actorID) => {
  const lock_key = `chatterloop:bump_lock:${conversationID}:chat`;

  // Sets the key in Redis only if absent (NX), expiring after 1800s (30 mins).
  const isLocked = await bumpLock(lock_key);
  if (!isLocked) return;

  const members = (memberIDs || []).filter(Boolean);
  if (members.length === 0) return;

  await publish(QUEUES.BUMP_CHAT_SCORE, {
    actor_id: actorID,
    member_ids: members,
    action: "CHAT",
    is_decrease: false,
  });
};

const followerInteractionScoreBump = async (
  actorID,
  receiverID,
  action,
  isDecrease,
) => {
  if (!receiverID) return;

  if (!INTERACTION_ACTIONS.has(action)) {
    console.log(
      `[followerInteractionScoreBump] unknown action ignored: ${action}`,
    );
    return;
  }

  await publish(QUEUES.FOLLOWER_INTERACTION_SCORE_BUMP, {
    actor_id: actorID,
    receiver_id: receiverID,
    action: action,
    is_decrease: !!isDecrease,
  });
};

/**
 * Fan a post out into its author's followers' timelines.
 *
 * The follower list is NO LONGER resolved here - the worker runs that query
 * itself from `current_entity_id`, so GetFollowerIDs is not needed on this
 * path. `currentEntityID` is whose followers receive the post, which is not
 * always the post's author: a comment bump fans someone else's post into the
 * COMMENTER's followers.
 */
const bulkFanoutToCache = async (currentEntityID, postData, type) => {
  await publish(QUEUES.BULK_FANOUT_TO_CACHE, {
    current_entity_id: String(currentEntityID),
    post_data: {
      id: String(postData.id),
      author_id: String(postData.author_id),
    },
    type: type || "fanout",
  });
};

module.exports = {
  interactionScoreBump,
  followerInteractionScoreBump,
  bulkFanoutToCache,
  bumpChatScore,
};
