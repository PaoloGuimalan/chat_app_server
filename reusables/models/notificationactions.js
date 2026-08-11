// Row destinations and buttons for a notification, per platform.
//
// Clients no longer decide which notification types are actionable - that used
// to be a hardcoded set in BOTH the webapp and the Flutter app
// (`_answerableTypes = {contact_request, follow_request}` plus an
// `isFollowRequest` branch to pick the endpoint), so every new actionable type
// cost a change in both and an app-store release for one of them.
//
// What a client does now is: filter to its own platform, sort by `order`,
// render. Anything it does not recognise, it skips.
//
// DERIVED, not stored - unless the document says otherwise. Notifications are
// written from two services (the Django user service writes contact_request,
// follow_request, follow, poke, post_comment, post_reaction, comment_reaction,
// comment_mention; this service writes tag_notification and
// shared_post_notification), and every notification already in the collection
// predates this feature. Deriving at read time means no writer changes in
// either language, no migration, and existing rows gain their buttons
// immediately. A document that DOES carry its own redirects/actions - an
// admin-authored notice, say - keeps them; see attachNotificationUx.

const PLATFORMS = ["web", "android", "ios"];

// The one place a route is spelled out per client. The three do not share a
// route table, which is the whole reason these are stored per platform:
//   profile       web /:handle          app /user/:handle
//   conversation  web /messages/:id     app /conversation/:id
//
// A null means that client has no destination for that kind of thing, and the
// row is simply not tappable there. `post` is null on web today because the
// webapp has no post permalink - it opens posts as a modal from search - so a
// post-backed notification cannot be linked to. Give it one and fill this in.
// Anchors are encoded DIFFERENTLY per platform, which is one of the things
// per-platform routes are for.
//
// Web gets a `#fragment`: it is what a browser natively scrolls to and what a
// user expects to be able to copy out of the address bar.
//
// The app gets `?anchor=`: go_router parses a location as a URI, so a `#` is a
// fragment rather than part of the path, and relying on it surviving route
// matching is fragile. A query parameter is read straightforwardly off
// `state.uri.queryParameters` and cannot interfere with matching.
//
// Either way a client that does not implement anchoring just opens the target,
// which is the point of it being optional.
const withHashAnchor = (route, anchor) =>
  route && anchor ? `${route}#${anchor}` : route;

const withQueryAnchor = (route, anchor) =>
  route && anchor
    ? `${route}${route.includes("?") ? "&" : "?"}anchor=${encodeURIComponent(anchor)}`
    : route;

const ROUTES = {
  profile: {
    web: (p) => (p.handle ? `/${p.handle}` : null),
    android: (p) => (p.handle ? `/user/${p.handle}` : null),
    ios: (p) => (p.handle ? `/user/${p.handle}` : null),
  },
  post: {
    // The webapp's post permalink (Home.tsx -> PostPage). It had none until
    // now - posts opened as a modal from search, so nothing could link to one,
    // which is why this used to be null and post-backed notifications were
    // untappable on web.
    web: (p) => (p.postId ? withHashAnchor(`/post/${p.postId}`, p.anchor) : null),
    android: (p) =>
      p.postId ? withQueryAnchor(`/post/${p.postId}`, p.anchor) : null,
    ios: (p) =>
      p.postId ? withQueryAnchor(`/post/${p.postId}`, p.anchor) : null,
  },
  conversation: {
    web: (p) => (p.conversationId ? `/messages/${p.conversationId}` : null),
    android: (p) =>
      p.conversationId ? `/conversation/${p.conversationId}` : null,
    ios: (p) => (p.conversationId ? `/conversation/${p.conversationId}` : null),
  },
  realm: {
    web: (p) => (p.slug ? `/realms/${p.slug}` : null),
    android: (p) => (p.slug ? `/realm/${p.slug}` : null),
    ios: (p) => (p.slug ? `/realm/${p.slug}` : null),
  },
  server: {
    web: (p) => (p.serverId ? `/servers/${p.serverId}` : null),
    android: (p) => (p.serverId ? `/server/${p.serverId}` : null),
    ios: (p) => (p.serverId ? `/server/${p.serverId}` : null),
  },
};

/// One redirect entry per platform. ALWAYS all three, route null where that
/// client has no destination - a missing platform and a null route mean the
/// same thing to a client, and writing all three keeps "was this considered?"
/// answerable by looking.
const buildRedirects = (kind, params) => {
  const table = ROUTES[kind];
  if (!table) return [];
  return PLATFORMS.map((platform) => ({
    platform,
    type: kind,
    route: table[platform](params || {}) ?? null,
  }));
};

/// Fans one logical button out across the platforms that should show it.
///
/// Gating is by omission: pass a shorter `platforms` list and the others simply
/// have no entry, which every client already treats as "do not render".
const forPlatforms = (action, platforms = PLATFORMS) =>
  platforms.map((platform) => ({ platform, ...action }));

// Both answer endpoints live on the DJANGO user service and take their
// approve/decline choice as an `action` HEADER rather than in the body - which
// is why the schema carries `headers` at all. Verified against the shipping
// clients (contacts_api.dart's acceptContactRequest/declineContactRequest and
// profile_api.dart's answerFollowRequest, and the webapp's equivalents).
const CONTACTS_PATH = "/api/user/contacts";
const FOLLOW_PATH = "/api/realm/follow";

/// Accept/decline for an incoming contact request.
///
/// referenceID is the CONNECTION id; fromUserID is the requester's entity id.
/// Both are needed by the endpoint.
const contactRequestActions = (notification) => [
  ...forPlatforms({
    id: "accept",
    name: "Confirm",
    type: "api-request",
    style: "primary",
    order: 0,
    after: "refresh",
    service: "user",
    url: CONTACTS_PATH,
    method: "PUT",
    payload: {
      connection_id: notification.referenceID,
      entity_id: notification.fromUserID,
    },
    headers: null,
  }),
  ...forPlatforms({
    id: "decline",
    name: "Decline",
    type: "api-request",
    style: "danger",
    order: 1,
    after: "refresh",
    service: "user",
    url: CONTACTS_PATH,
    method: "DELETE",
    payload: {
      connection_id: notification.referenceID,
      entity_id: notification.fromUserID,
    },
    // "decline" rejects an incoming request; "remove" would cancel a sent one
    // or unfriend. Only the former is reachable from a notification.
    headers: { action: "decline" },
  }),
];

/// Approve/decline for a follow of a PRIVATE profile.
///
/// referenceID here is the REQUESTER'S ENTITY ID, not a connection id - there
/// is no connection row for a follow - which is also why the server settles
/// these with update_reference_status_by_type rather than by referenceID alone.
const followRequestActions = (notification) => [
  ...forPlatforms({
    id: "approve",
    name: "Confirm",
    type: "api-request",
    style: "primary",
    order: 0,
    after: "refresh",
    service: "user",
    url: FOLLOW_PATH,
    method: "PUT",
    payload: { target_id: notification.referenceID },
    headers: { action: "approve" },
  }),
  ...forPlatforms({
    id: "decline",
    name: "Decline",
    type: "api-request",
    style: "danger",
    order: 1,
    after: "refresh",
    service: "user",
    url: FOLLOW_PATH,
    method: "PUT",
    payload: { target_id: notification.referenceID },
    headers: { action: "decline" },
  }),
];

// Which destination each type points at. `params` is resolved by the caller,
// which is the only thing that knows the sender's handle / the post id.
//
// Anything absent from this map gets no redirect and no actions, which is the
// correct default: a type nobody has mapped should render as a plain row rather
// than guess a destination.
const REDIRECT_KIND_BY_TYPE = {
  // All of these open the SENDER's profile, and for all of them fromUserID is
  // the person the row is about - the requester, the follower, the poker. Note
  // `follow` stores the FOLLOWEE (i.e. the recipient) in referenceID, so
  // referenceID is the wrong id to route on here; fromUserID is the right one.
  contact_request: "profile",
  follow_request: "profile",
  info_contact_accept: "profile",
  info_contact_decline: "profile",
  follow: "profile",
  poke: "profile",

  // ONLY these two. Both are written by this service and store the POST id in
  // referenceID.
  //
  // The other post-shaped types are deliberately absent, because referenceID is
  // NOT a post id for them - the Django writers store the id of the thing that
  // was created, not the post it hangs off:
  //   post_reaction     -> reaction id
  //   post_comment      -> comment id
  //   comment_reaction  -> reaction id
  //   comment_mention   -> comment id
  // Routing those to /post/<referenceID> would produce a confidently wrong deep
  // link, which is worse than no link. Giving them a destination needs either
  // the Django side to store the post id as well, or a lookup here that
  // resolves reaction/comment -> post. Until then they render as plain rows.
  tag_notification: "post",
  shared_post_notification: "post",
};

/// The destination kind for a notification.
///
/// `target.type` wins when the writer supplied one - that is the field's whole
/// purpose, and it is the only thing that can be right for the types where
/// referenceID is a reaction or comment id. The type map is the fallback for
/// rows written before `target` existed.
const redirectKindFor = (notification) =>
  notification.target?.type || REDIRECT_KIND_BY_TYPE[notification.type] || null;

/// Route params for a notification, given its resolved sender.
///
/// Lives here rather than at the call sites so the "which id does this type
/// actually carry?" question has ONE answer - the read paths only know they
/// have a notification and a sender row.
///
/// `sender` is the joined fromUser: v2 exposes `handle`, v1 exposes `username`.
const paramsFor = (notification, sender) => {
  const target = notification.target || {};
  const anchor = target.anchor || null;

  switch (redirectKindFor(notification)) {
    case "profile":
      // Resolved from the SENDER, never from target.supportingID.
      //
      // A profile route is keyed by HANDLE, and a handle is not a stable id: a
      // target storing one would freeze whatever it was on the day the
      // notification was written, and a target storing an entity id would
      // render /user/<uuid>. The sender join already resolves the current
      // handle on every read, which is both correct and self-updating - so the
      // profile types deliberately carry no `target` at all.
      //
      // Pointing a profile row at somebody OTHER than the sender would need an
      // entity-id -> handle resolution step here; build that when a type
      // actually needs it rather than guessing now.
      return {
        handle: sender?.handle || sender?.username || null,
        anchor,
      };
    case "post":
      // target.supportingID is the POST id. referenceID is only correct here
      // for the two Node-written types, which is why it is the fallback and not
      // the primary.
      return {
        postId:
          target.supportingID ||
          (REDIRECT_KIND_BY_TYPE[notification.type] === "post"
            ? notification.referenceID
            : null) ||
          null,
        anchor,
      };
    case "conversation":
      return { conversationId: target.supportingID || null, anchor };
    case "realm":
      return { slug: target.supportingID || null, anchor };
    case "server":
      return { serverId: target.supportingID || null, anchor };
    default:
      return {};
  }
};

const ACTIONS_BY_TYPE = {
  contact_request: contactRequestActions,
  follow_request: followRequestActions,
};

/// Whether a type's buttons are still answerable.
///
/// referenceStatus stays the single source of truth for "settled": it is what
/// the clients already gate on, and what the Django side flips when a request
/// is answered. Deriving from it rather than storing a per-action state keeps
/// one answer to the question instead of two that can disagree.
const isUnsettled = (notification) => notification.referenceStatus !== true;

/// Attaches `redirects` and `actions` to ONE notification.
///
/// Stored values win. A document that carries its own - an admin-authored
/// notice with bespoke buttons - is returned untouched, so authoring is not
/// fighting the derivation.
///
/// `params` supplies what the type's destination needs (handle, postId, ...);
/// the caller resolves those because only it has the joined sender rows.
const attachNotificationUx = (notification, params = {}) => {
  const plain =
    typeof notification?.toObject === "function"
      ? notification.toObject()
      : { ...notification };

  const hasStoredRedirects =
    Array.isArray(plain.redirects) && plain.redirects.length > 0;
  const hasStoredActions =
    Array.isArray(plain.actions) && plain.actions.length > 0;

  if (!hasStoredRedirects) {
    const kind = redirectKindFor(plain);
    plain.redirects = kind ? buildRedirects(kind, params) : [];
  }

  if (!hasStoredActions) {
    const builder = ACTIONS_BY_TYPE[plain.type];
    plain.actions = builder && isUnsettled(plain) ? builder(plain) : [];
  }

  return plain;
};

module.exports = {
  PLATFORMS,
  ROUTES,
  buildRedirects,
  forPlatforms,
  paramsFor,
  redirectKindFor,
  attachNotificationUx,
  REDIRECT_KIND_BY_TYPE,
  ACTIONS_BY_TYPE,
};
