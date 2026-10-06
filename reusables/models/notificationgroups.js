// Grouped notifications: "Maya and 4 others reacted to your post" as ONE
// collapsible row instead of five.
//
// WHAT MAY GROUP, AND WHY IT IS AN ALLOWLIST
// ------------------------------------------
// Two notifications share a row only when they are the same ACTION on the
// same THING - and only for the types listed in GROUP_SPECS. Everything else
// is a group of one. An allowlist rather than a rule, because "same type, same
// target" is not enough on its own:
//
//   - A type can carry two different actions. `post_comment` is written both
//     for "commented on your post" and for "replied to your comment" (Django
//     newsfeed/views.py), and `follow` both for "started following you" and
//     for "approved your follow request" (community/views.py). They differ
//     only by headline, so the headline is part of the key. Replies group by
//     the POST they are on - that is all their target says; which of your
//     comments each one answers is in its own sentence, shown once expanded.
//
//   - Rows can carry BUTTONS. Two notifications can agree on type and target
//     and still differ in what their buttons do - a contact request's Confirm
//     is addressed to ITS connection id. A row's buttons are either stored on
//     the document (an admin notice) or DERIVED from it at read time
//     (notificationactions.js, ACTIONS_BY_TYPE). A group's own row NEVER has
//     buttons, so there are two safe ways to group rows that have them:
//       * by default, stored `actions` and `redirects` are part of the key -
//         rows with different stored buttons can never merge - and no type
//         with derived buttons may be listed;
//       * a spec marked `memberActions` instead keeps every button on its own
//         row inside the expanded group, where it is answered one by one. Its
//         key leaves buttons out on purpose, since nothing ever acts for the
//         group as a whole.
//     assertActionsSafe checks this at load, so listing a type with derived
//     buttons without `memberActions` fails loud instead of quietly merging
//     requests that each need their own answer.
//
//   - Connections group by PERSON (the "people" family below): every request,
//     accept, decline and approval between you and one other party is one
//     row, whatever its type - the thing those rows share is the relationship.
//     referenceID cannot be the key: it is the connection id for the contact
//     types (one per pair, but a fresh one when a declined pair tries again)
//     and the other party's entity id for the follow types, so it would split
//     one person into two rows. fromUserID is that other party for every one
//     of them. "Started following you" is the exception: it stays grouped by
//     recipient, "Maya and 11 others started following you", because twelve
//     people following you is one piece of news, not twelve relationships.
//     Invites never group - each is about a different realm.
//
//   - A row written before `target` existed has no idea which post it is
//     about (its referenceID is a reaction or comment id). Without a target it
//     stays on its own rather than being lumped with other posts.
//
// The key is computed IN MONGO, so pagination is over groups: a page is N
// rows the way the reader sees them, and a group never straddles two pages.

const crypto = require("crypto");
const { ACTIONS_BY_TYPE } = require("./notificationactions");

/// One groupable action. `by` says which "thing" the rows must share:
///   target        - target.supportingID (the post)
///   targetAnchor  - the post AND target.anchor (the comment on it)
///   targetOrRef   - target.supportingID, else referenceID (a Node-written
///                   type whose referenceID IS the post id)
///   recipient     - nothing beyond the recipient: "started following YOU"
///   sender        - the other party (fromUserID): the people family
/// `headline`, when present, must match exactly - see the header.
/// `action` finishes the sentence after the people: "Maya and 2 others ___".
///
/// A `family` groups SEVERAL types together - its rows key on the family name
/// instead of their type and headline. Its sentence is built from what the
/// group actually holds, each member's `phrase` once, newest first: "Juan sent
/// you a contact request and approved your follow request".
///
/// `memberActions` - the rows have buttons of their own, kept on each row
/// inside the group; see the header.
const PEOPLE = "people";
const peopleSpec = (type, phrase, headline) => ({
  type,
  ...(headline ? { headline } : {}),
  family: PEOPLE,
  by: "sender",
  memberActions: true,
  phrase,
});

const GROUP_SPECS = [
  { type: "post_reaction", by: "target", action: "reacted to your post" },
  { type: "moment_reaction", by: "target", action: "reacted to your moment" },
  { type: "thought_reaction", by: "target", action: "reacted to your thought" },
  {
    type: "comment_reaction",
    by: "targetAnchor",
    action: "reacted to your comment",
  },
  {
    type: "post_comment",
    headline: "Post Comment",
    by: "target",
    action: "commented on your post",
  },
  {
    // The post the replies are on. Each one answers one of your comments - the
    // sentence it carries names which - so the group's own row only says where.
    type: "post_comment",
    headline: "Replied Comment",
    by: "target",
    action: "replied to your comments on a post",
  },
  {
    type: "comment_mention",
    by: "target",
    action: "mentioned you in comments on a post",
  },
  {
    type: "shared_post_notification",
    by: "targetOrRef",
    action: "shared your post",
  },
  // BEFORE the people family, which a follow would otherwise fall into - the
  // first matching spec wins. See the header.
  {
    type: "follow",
    headline: "New Follower",
    by: "recipient",
    action: "started following you",
  },

  // Connections, one row per person. Each request keeps its own Confirm and
  // Decline - addressed to ITS connection id or requester - on its own row.
  peopleSpec("contact_request", "sent you a contact request"),
  peopleSpec("info_contact_accept", "accepted your request"),
  peopleSpec("info_contact_decline", "declined your request"),
  peopleSpec("follow_request", "asked to follow you"),
  peopleSpec(
    "follow",
    "approved your follow request",
    "Follow Request Approved",
  ),
];

/// A type with derived buttons may only group as `memberActions` - see the
/// header - and a family needs every member to say what it did.
const assertActionsSafe = (specs = GROUP_SPECS) => {
  const clash = specs.filter(
    (spec) => ACTIONS_BY_TYPE[spec.type] && !spec.memberActions,
  );
  if (clash.length > 0) {
    throw new Error(
      `notificationgroups: ${clash
        .map((s) => s.type)
        .join(", ")} derive per-row actions and may only group with memberActions`,
    );
  }
  const mute = specs.filter((spec) => (spec.family ? !spec.phrase : !spec.action));
  if (mute.length > 0) {
    throw new Error(
      `notificationgroups: ${mute
        .map((s) => s.type)
        .join(", ")} cannot be put into words`,
    );
  }
};
assertActionsSafe();

/// The "thing" a spec groups on, as a Mongo expression.
const thingOf = (spec) => {
  switch (spec.by) {
    case "target":
    case "targetAnchor":
      return "$target.supportingID";
    case "targetOrRef":
      return { $ifNull: ["$target.supportingID", "$referenceID"] };
    case "recipient":
      return "$toUserID";
    case "sender":
      return "$fromUserID";
    default:
      throw new Error(`notificationgroups: unknown grouping "${spec.by}"`);
  }
};

/// `{ $gt: [x, null] }` is Mongo's "present and not null": a missing field and
/// a null both compare as not greater than null.
const present = (expr) => ({ $gt: [expr, null] });

/// A stored array, or null when there is none - an EMPTY array included.
/// "No stored buttons" has three spellings in the collection (missing, null,
/// []: the Django writer never stores [], but nothing else promises that),
/// and all three must key alike or identical rows would refuse to group.
const storedList = (field) => ({
  $cond: [
    { $isArray: field },
    { $cond: [{ $gt: [{ $size: field }, 0] }, field, null] },
    null,
  ],
});

/// The grouping key, as a Mongo expression over one notification document.
///
/// Every branch builds the same shape in the same field order - a document
/// key compares field by field, in order - and the default is the row's own
/// _id, so anything not provably groupable is a group of one.
const groupKeyExpression = (specs = GROUP_SPECS) => ({
  $switch: {
    branches: specs.map((spec) => {
      const thing = thingOf(spec);
      const conditions = [{ $eq: ["$type", spec.type] }, present(thing)];
      if (spec.headline) {
        conditions.push({ $eq: ["$content.headline", spec.headline] });
      }
      if (spec.by === "targetAnchor") {
        conditions.push(present("$target.anchor"));
      }
      return {
        case: { $and: conditions },
        then: {
          // A family keys on its name, so its types share one row.
          type: spec.family || "$type",
          headline: spec.headline && !spec.family ? "$content.headline" : null,
          thing,
          anchor: spec.by === "targetAnchor" ? "$target.anchor" : null,
          // Stored buttons and destinations are part of WHAT the row does, so
          // they are part of the key - unless every button stays on its own
          // row (memberActions). See the header.
          actions: spec.memberActions ? null : storedList("$actions"),
          redirects: spec.memberActions ? null : storedList("$redirects"),
        },
      };
    }),
    default: { single: "$_id" },
  },
});

/// The spec a document grouped under - the JS twin of the $switch above, used
/// to label a group. Null for a group of one.
const specFor = (doc, specs = GROUP_SPECS) => {
  if (!doc) return null;
  for (const spec of specs) {
    if (doc.type !== spec.type) continue;
    if (spec.headline && doc.content?.headline !== spec.headline) continue;
    return spec;
  }
  return null;
};

/// "a, b and c".
const joinPhrases = (phrases) =>
  phrases.length <= 1
    ? (phrases[0] ?? null)
    : `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;

/// What a group's row says after the names, from its items (newest first).
/// One action for an ordinary spec; for a family, what its members did - each
/// phrase once, newest first.
const groupSentence = (items, specs = GROUP_SPECS) => {
  const spec = specFor(items[0], specs);
  if (!spec) return null;
  if (!spec.family) return spec.action;
  const phrases = [];
  for (const item of items) {
    const phrase = specFor(item, specs)?.phrase;
    if (phrase && !phrases.includes(phrase)) phrases.push(phrase);
  }
  return joinPhrases(phrases);
};

/// A stable id for a group, so a client can keep it expanded across
/// refetches. The latest notification's id would change with every new
/// reaction; the key does not.
const groupIdOf = (key) =>
  crypto
    .createHash("sha1")
    .update(JSON.stringify(key))
    .digest("hex")
    .slice(0, 20);

/// The newest rows a group carries for its expanded view. A group of 900
/// reactions is still one row; expanding it shows the latest ones and says
/// how many more there are.
const ITEMS_PER_GROUP = 20;

/// One page of a section, grouped.
///
/// Two steps, because a group's members must never travel whole through the
/// $group stage: a document there is capped at 16MB, and a post with enough
/// reactions would reach it. The aggregation carries only ids; the newest
/// ITEMS_PER_GROUP of each group on THIS page are then read in one query.
///
/// `unread` counts NOTIFICATIONS, as the ungrouped endpoints do, so the badges
/// mean the same thing either way. `total` and `next` count GROUPS - they
/// drive paging, and a page is groups.
const fetchGroupedNotificationSection = async (
  UserNotifications,
  match,
  page,
  range,
) => {
  const skip = (parseInt(page) - 1) * parseInt(range);
  const result = await UserNotifications.aggregate(
    [
      { $match: match },
      { $sort: { _id: -1 } },
      { $addFields: { _groupKey: groupKeyExpression() } },
      {
        $group: {
          _id: "$_groupKey",
          // Sorted newest-first above, so $first is the newest and $push
          // collects newest-first.
          latest: { $first: "$_id" },
          ids: { $push: "$_id" },
          count: { $sum: 1 },
          unread: { $sum: { $cond: [{ $eq: ["$isRead", false] }, 1, 0] } },
          actors: { $addToSet: "$fromUserID" },
        },
      },
      { $sort: { latest: -1 } },
      {
        $facet: {
          metadata: [{ $count: "total" }],
          unread: [{ $group: { _id: null, total: { $sum: "$unread" } } }],
          data: [
            { $skip: skip },
            { $limit: parseInt(range) },
            {
              $project: {
                ids: { $slice: ["$ids", ITEMS_PER_GROUP] },
                count: 1,
                unread: 1,
                actorCount: { $size: "$actors" },
              },
            },
          ],
        },
      },
    ],
    { allowDiskUse: true },
  );

  const facet = result[0] || {};
  const total = facet.metadata?.[0]?.total || 0;
  const unread = facet.unread?.[0]?.total || 0;
  const rows = facet.data || [];

  const ids = rows.flatMap((row) => row.ids);
  const docs = ids.length
    ? await UserNotifications.find({ _id: { $in: ids } }).lean()
    : [];
  const byId = new Map(docs.map((doc) => [String(doc._id), doc]));

  const groups = rows.map((row) => {
    const items = row.ids
      .map((id) => byId.get(String(id)))
      .filter(Boolean);
    return {
      key: groupIdOf(row._id),
      count: row.count,
      unread: row.unread,
      actorCount: row.actorCount,
      // The sentence's verb half, only for a real group - a single row keeps
      // its own stored sentence.
      action: row.count > 1 ? groupSentence(items) : null,
      items,
    };
  });

  return {
    groups,
    total,
    unread,
    next: total - parseInt(range) * parseInt(page) > 0,
  };
};

module.exports = {
  GROUP_SPECS,
  ITEMS_PER_GROUP,
  assertActionsSafe,
  groupKeyExpression,
  specFor,
  groupSentence,
  groupIdOf,
  fetchGroupedNotificationSection,
};
