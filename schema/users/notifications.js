const mongoose = require("mongoose")

// Platforms a redirect/action can be addressed to. Android and iOS are listed
// separately even though the Flutter app currently resolves both to the same
// route table - the entries are written per platform so iOS can diverge later
// (universal links being the likely first case) without a schema change.
const PLATFORMS = ["web", "android", "ios"]

// Where tapping the notification ROW goes, per platform.
//
// One entry per platform, always written (route null where there is no
// destination for that client). A client reads only its own entry; a missing
// entry or a null route means the row is not tappable there, which is what
// keeps a tap from landing on nothing.
const notificationRedirect = mongoose.Schema(
    {
        platform: { type: String, enum: PLATFORMS, required: true },
        // "post" | "profile" | "conversation" | "realm" | "server" | "external".
        // Descriptive: clients key their rendering off `route`, and this says
        // what kind of thing is on the other end.
        type: { type: String, default: null },
        // In-app path for that client, or an absolute URL when type is
        // "external". Paths are per platform because the three clients do not
        // share a route table (/messages/:id on web vs /conversation/:id in the
        // app).
        route: { type: String, default: null },
    },
    { _id: false },
)

// A button on the notification.
//
// Also one entry PER PLATFORM: the same logical button is repeated for each
// client that should show it, sharing an `id`. Gating an action to some
// platforms is therefore just omitting the others - there is no separate
// enabled flag to keep in sync.
const notificationAction = mongoose.Schema(
    {
        platform: { type: String, enum: PLATFORMS, required: true },
        // Stable across the per-platform copies of the same button, and unique
        // within one platform's set. Identifies the action in logs and lets a
        // client correlate its copies.
        id: { type: String, required: true },
        // Button label, as shown.
        name: { type: String, required: true },
        type: {
            type: String,
            enum: [
                // Call our own API. `url` MUST be a PATH, resolved against the
                // base named by `service`. The client sends its access token.
                //
                // Path-only is a security rule, not a convention: an absolute
                // url here would let a stored row aim an AUTHENTICATED request
                // at any host, and these rows are generated from other users'
                // actions. Clients reject an absolute url on this kind.
                "api-request",
                // Navigate within the app to `route`.
                "in-app-redirect",
                // Open `url` outside the app. Absolute url.
                "external-redirect",
                // Call a THIRD PARTY. `url` must be ABSOLUTE, and clients send
                // NO credentials of ours with it - no access token, no cookies.
                // Our token is a bearer credential for the whole account, so it
                // never leaves our own origins.
                //
                // If an integration needs our identity, it belongs behind an
                // "api-request" to a proxy endpoint on our own server, where
                // the outbound credentials are ours to control.
                "external-api-request",
            ],
            required: true,
        },
        style: {
            type: String,
            enum: ["primary", "secondary", "danger"],
            default: "secondary",
        },
        // Render order after a client filters to its own platform. A flat array
        // grouped by button rather than by platform would otherwise render in
        // whatever order the writer happened to append.
        order: { type: Number, default: 0 },
        // What the UI does once the action succeeds.
        after: {
            type: String,
            enum: ["dismiss", "refresh", "none"],
            default: "refresh",
        },

        // in-app-redirect
        route: { type: String, default: null },

        // api-request / external-*
        //
        // For "api-request" this is a PATH, never an absolute URL, and `service`
        // says which base to resolve it against - the stack has two (Django's
        // user service and this Node realtime service) and a path alone cannot
        // say which. Absolute URLs belong only to the external kinds.
        url: { type: String, default: null },
        service: {
            type: String,
            enum: ["user", "realtime", null],
            default: null,
        },
        method: { type: String, default: null },
        payload: { type: mongoose.Schema.Types.Mixed, default: null },
        // Sent as request headers. Present because two real actions need it -
        // the contact and follow endpoints both take their approve/decline
        // choice as an `action` header rather than in the body.
        headers: { type: mongoose.Schema.Types.Mixed, default: null },
    },
    { _id: false },
)

// WHERE the notification points, for the client.
//
// Deliberately separate from `referenceID`, which is a BACKEND field: it holds
// whatever id the server-side action needs (a connection id to accept, a
// requester's entity id to approve) and its meaning changes per type. It is
// also frequently NOT the thing the user wants to look at - a post_reaction
// stores the REACTION id, a post_comment the COMMENT id - so routing off it
// produced either nothing or a confidently wrong deep link.
//
// `target` answers only the client's question: what is on the other end of
// this row, and which id opens it.
const notificationTarget = mongoose.Schema(
    {
        // "post" | "profile" | "conversation" | "realm" | "server" | ...
        type: { type: String, default: null },
        // The id of that thing - the POST id for a comment notification, not
        // the comment's.
        supportingID: { type: String, default: null },
        // Optional: what to scroll to once there. A comment notification opens
        // the post (supportingID) at that comment (anchor). Clients that do not
        // implement anchoring just open the target and are none the worse.
        anchor: { type: String, default: null },
    },
    { _id: false },
)

const usernotifications = mongoose.Schema({
    notificationID: { type: mongoose.Schema.Types.Mixed, require: true },
    // BACKEND id - see notificationTarget above for why the client does not
    // route off this.
    referenceID: { type: mongoose.Schema.Types.Mixed, require: true },
    referenceStatus: { type: Boolean, require: true },
    toUserID: { type: mongoose.Schema.Types.Mixed, require: true },
    fromUserID: { type: mongoose.Schema.Types.Mixed, require: true },
    content: {
        headline: { type: mongoose.Schema.Types.Mixed, require: true },
        details: { type: mongoose.Schema.Types.Mixed, require: true },
    },
    date: {
        date: {type: mongoose.Schema.Types.Mixed, require: true},
        time: {type: mongoose.Schema.Types.Mixed, require: true}
    },
    type: { type: mongoose.Schema.Types.Mixed, require: true },
    isRead: { type: mongoose.Schema.Types.Mixed, require: true },

    // Data-driven row destination and buttons.
    //
    // OPTIONAL on the document. Most notifications are written by the Django
    // user service (12 call sites) and by this service's post routes, none of
    // which fill these in - and every notification already in the collection
    // predates them. So the read path DERIVES both from `type` when they are
    // absent (see reusables/models/notificationactions.js), and what is stored
    // here wins when present.
    //
    // That split is what makes an admin-authored notice able to carry bespoke
    // buttons while the ordinary types need no writer changes and no backfill.
    redirects: { type: [notificationRedirect], default: undefined },
    actions: { type: [notificationAction], default: undefined },

    // Client-facing destination. Optional: rows written before this existed
    // have none, and the read path falls back to what it can infer from `type`
    // + `referenceID` for the handful of types where that is actually correct.
    target: { type: notificationTarget, default: undefined },
})

module.exports = mongoose.model("UserNotifications", usernotifications, "notifications")
module.exports.PLATFORMS = PLATFORMS
