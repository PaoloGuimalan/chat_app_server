/**
 * Dev-only FCM test sender. Nothing in the app imports this - it exists so the
 * mobile push UI can be exercised end-to-end before the real send path is
 * wired into /sendMessage.
 *
 * The payloads it builds are the contract the app expects, documented in
 * chatterloop_app/lib/core/notifications/push_payload.dart. Two shapes:
 *
 *   message   -> threaded MessagingStyle tray entry, one row per conversation
 *   activity  -> plain title/body card on the quieter "Activity" channel
 *
 * Both are sent DATA-ONLY, with no `notification` block, on purpose: a
 * notification block makes Android render the push itself while the app is
 * backgrounded, which skips the app's renderer entirely and loses the threaded
 * layout. `android.priority: high` is likewise required - normal priority gets
 * batched by Doze and can arrive minutes late.
 *
 * Usage:
 *   # Inspect first. Dumps EVERY session row for an entity with its full
 *   # token and whether it would receive a push - this is where the tokens
 *   # come from, since jwtchecker already stores them on each authed request.
 *   node scripts/sendTestPush.js --entity <ENTITY_ID> --list
 *
 *   # Send to one specific device, using a token from --list above.
 *   node scripts/sendTestPush.js --token <FCM_TOKEN>
 *   node scripts/sendTestPush.js --token <FCM_TOKEN> --type activity
 *
 *   # Send using the REAL targeting query against the sessions collection:
 *   # every device for this entity that has no live SSE connection but is
 *   # still logged in. This is the query the production send path will use.
 *   node scripts/sendTestPush.js --entity <ENTITY_ID>
 *   node scripts/sendTestPush.js --entity <ENTITY_ID> --dry-run
 *
 * Options:
 *   --type message|activity   payload shape (default: message)
 *   --body "..."              message text / notification body
 *   --sender "@name"          sender display name (message only)
 *   --convo <id>              conversationId to deep-link to (message only)
 *   --group                   render as a group conversation (message only)
 *   --route /user/paulo       deep link for an activity push
 *   --img <url>               activity thumbnail, square (post/content image)
 *   --avatar <url>            activity thumbnail, circular (person) - also the
 *                             sender's avatar on a message push
 *                             omit both -> no thumbnail at all
 *   --list                    dump all sessions for --entity, send nothing
 *   --dry-run                 resolve targets and print the payload, send nothing
 */

require("dotenv").config();
const mongoose = require("mongoose");
const firebase = require("firebase-admin");

const MongooseConnection = require("../connections/index");
const UserSessions = require("../schema/auth/sessions");
const Conversation = require("../schema/messages/conversation");
const {
  FIREBASE_TYPE,
  FIREBASE_PROJECT_ID,
  FIREBASE_PRIVATE_KEY_ID,
  FIREBASE_PRIVATE_KEY,
  FIREBASE_CLIENT_EMAIL,
  FIREBASE_CLIENT_ID,
  FIREBASE_AUTH_URI,
  FIREBASE_TOKEN_URI,
  FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
  FIREBASE_CLIENT_X509_CERT_URL,
  FIREBASE_UNIVERSE_DOMAIN,
} = require("../reusables/vars/firebasevars");

// ─── args ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--")
    ? argv[i + 1]
    : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const TOKEN = flag("token");
const ENTITY = flag("entity");
const TYPE = flag("type", "message");
const DRY_RUN = has("dry-run");
const LIST_ONLY = has("list");

/**
 * Lists real conversationIDs instead of sending.
 *
 * Needed because a message notification only gets Android's Conversation
 * layout when its shortcutId matches a shortcut the app has published - and
 * the app publishes one per conversationID it has actually loaded. An invented
 * --convo can therefore never show that layout, however correct the payload.
 * Resolves the entity from --token when --entity isn't given, since the
 * fcmToken is already on the session row.
 */
const CONVOS_ONLY = has("convos");

/**
 * Adds a `notification` block so ANDROID renders the push itself, instead of
 * handing it to the app's background isolate.
 *
 * Two uses. First as a diagnostic: it displays on any build, including ones
 * that predate the app's notification renderer, so it isolates "is delivery
 * working" from "is the app rendering it". Second, it's the Tier-1 fallback
 * shape - less pretty (no avatars, no threading) but rendered by Google Play
 * Services rather than a background isolate, which is more robust on OEMs with
 * aggressive battery management. `tag` still collapses per conversation.
 */
const WITH_NOTIFICATION = has("notification");

if (!TOKEN && !ENTITY) {
  console.error(
    "Need a target: --token <FCM_TOKEN> or --entity <ENTITY_ID>.\n" +
      "See the usage block at the top of this file.",
  );
  process.exit(1);
}

// ─── firebase ────────────────────────────────────────────────────────────────

// Same credentials the app server already uses for Storage. Note the
// JSON.parse on the private key: the env var holds a JSON object, not a raw
// PEM, because PEM newlines don't survive a flat .env value.
firebase.initializeApp({
  credential: firebase.credential.cert({
    type: FIREBASE_TYPE,
    project_id: FIREBASE_PROJECT_ID,
    private_key_id: FIREBASE_PRIVATE_KEY_ID,
    private_key: JSON.parse(FIREBASE_PRIVATE_KEY).privateKey,
    client_email: FIREBASE_CLIENT_EMAIL,
    client_id: FIREBASE_CLIENT_ID,
    auth_uri: FIREBASE_AUTH_URI,
    token_uri: FIREBASE_TOKEN_URI,
    auth_provider_x509_cert_url: FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
    client_x509_cert_url: FIREBASE_CLIENT_X509_CERT_URL,
    universe_domain: FIREBASE_UNIVERSE_DOMAIN,
  }),
});

// ─── payloads ────────────────────────────────────────────────────────────────

function buildData() {
  if (TYPE === "activity") {
    const data = {
      type: flag("kind", "contact_request"),
      title: flag("title", "Contact Request"),
      body: flag("body", "@testuser sent you a contact request."),
    };
    const route = flag("route");
    if (route) data.route = route;

    // Thumbnail is content-driven and blank when neither is sent. imageUrl
    // (square) is for events with content behind them - a post that was liked;
    // avatar (circular) is for person-centric ones like contact requests.
    const image = flag("img");
    if (image) data.imageUrl = image;
    const avatar = flag("avatar");
    if (avatar) data.senderAvatarUrl = avatar;

    return data;
  }

  return {
    type: "message",
    conversationId: flag("convo", "CNV_TEST_0001"),
    conversationName: flag("convo-name", has("group") ? "Test Group" : "Paolo"),
    isGroup: String(has("group")),
    senderId: "ENT_TEST_SENDER",
    senderName: flag("sender", "@testuser"),
    body: flag("body", "Test push - does this look right?"),
    sentAt: String(Date.now()),
    messageId: `MSG_${Date.now()}`,
    // senderAvatarUrl is intentionally omitted by default - pass one to check
    // avatar fetching:  --avatar https://.../pic.jpg
    ...(flag("avatar") ? { senderAvatarUrl: flag("avatar") } : {}),
  };
}

/**
 * The production targeting rule, verbatim:
 *   status === false  -> no live SSE connection, so SSE won't deliver this
 *   fcmToken != null  -> still logged in there (logout + entity switch null it)
 * Devices that ARE connected get the message over SSE already; pushing to them
 * too would double-notify.
 */
async function tokensForEntity(entityID) {
  const rows = await UserSessions.find(
    {
      entityID: String(entityID),
      status: false,
      fcmToken: { $nin: [null, ""] },
    },
    { fcmToken: 1, deviceType: 1, os: 1, lastSeen: 1 },
  ).lean();

  console.log(`Matched ${rows.length} offline session(s) for ${entityID}:`);
  rows.forEach((r) =>
    console.log(
      `  - ${r.os || "?"}/${r.deviceType || "?"}  lastSeen=${r.lastSeen || "?"}  ` +
        `token=…${String(r.fcmToken).slice(-12)}`,
    ),
  );

  // Same device can hold rows for several entities - don't send twice.
  return [...new Set(rows.map((r) => r.fcmToken))];
}

/**
 * Every session row for an entity, with the verdict for each. Use this to
 * answer "why didn't my phone get the push?" - the three no-send reasons look
 * identical from the outside but have completely different fixes.
 *
 * This is also where test tokens come from: jwtchecker already writes fcmToken
 * on every authenticated request, so the device's token is in Mongo without the
 * app needing to surface it anywhere.
 */
async function listSessions(entityID) {
  const rows = await UserSessions.find({ entityID: String(entityID) })
    .sort({ lastSeen: -1 })
    .lean();

  if (!rows.length) {
    console.log(`No sessions at all for ${entityID} - is the id correct?`);
    return;
  }

  console.log(`${rows.length} session(s) for ${entityID}:\n`);
  rows.forEach((r, i) => {
    const verdict = r.status
      ? "SKIP - online, SSE delivers this instead"
      : !r.fcmToken
        ? "SKIP - no fcmToken (logged out, or never sent the header)"
        : "WOULD RECEIVE PUSH";

    console.log(`[${i + 1}] ${r.os || "?"} / ${r.deviceType || "?"} / ${r.browser || "?"}`);
    console.log(`    status   : ${r.status} ${r.status ? "(online now)" : "(offline)"}`);
    console.log(`    lastSeen : ${r.lastSeen || "?"}`);
    console.log(`    device   : ${r.deviceToken}`);
    console.log(`    fcmToken : ${r.fcmToken || "(null)"}`);
    console.log(`    -> ${verdict}\n`);
  });
}

/** The entity that owns a given fcmToken, per the session rows. */
async function entityForToken(token) {
  const row = await UserSessions.findOne({ fcmToken: token }, { entityID: 1 })
    .lean();
  return row ? row.entityID : null;
}

/** Recent real conversations for an entity, newest first. */
async function listConversations(entityID) {
  const rows = await Conversation.find(
    { participant_ids: entityID },
    { conversationID: 1, conversationType: 1, last_message: 1 },
  )
    .sort({ "last_message.messageDate": -1 })
    .limit(10)
    .lean();

  if (!rows.length) {
    console.log(`No conversations for ${entityID}.`);
    return;
  }

  console.log(`Recent conversations for ${entityID}:\n`);
  rows.forEach((r, i) => {
    const text = String(r.last_message?.text || "").slice(0, 40);
    console.log(`[${i + 1}] ${r.conversationID}`);
    console.log(`    type: ${r.conversationType}  last: "${text}"\n`);
  });
  console.log("Pass one of these as --convo to test the Conversation layout.");
}

// ─── send ────────────────────────────────────────────────────────────────────

async function main() {
  let tokens = [];

  if (CONVOS_ONLY) {
    await mongoose.connect(MongooseConnection.url, MongooseConnection.params);
    const entity = ENTITY || (await entityForToken(TOKEN));
    if (!entity) {
      console.log(
        "Couldn't resolve an entity. If you passed --token, the device may not\n" +
          "have made an authenticated request since installing, so jwtchecker\n" +
          "hasn't stored this token yet - open the app while logged in first.",
      );
      return;
    }
    return listConversations(entity);
  }

  if (ENTITY) {
    await mongoose.connect(MongooseConnection.url, MongooseConnection.params);
    if (LIST_ONLY) return listSessions(ENTITY);
    tokens = await tokensForEntity(ENTITY);
  } else {
    tokens = [TOKEN];
  }

  const data = buildData();

  console.log(`\nPayload (${TYPE}):`);
  console.log(JSON.stringify({ data, android: { priority: "high" } }, null, 2));

  if (!tokens.length) {
    console.log("\nNo target tokens - nothing to send.");
    return;
  }
  if (DRY_RUN) {
    console.log(`\n--dry-run: would send to ${tokens.length} token(s).`);
    return;
  }

  // v13 removed sendMulticast()/sendAll(); sendEachForMulticast replaces them
  // and returns per-token results, which is what a real send path needs to
  // know which tokens to prune.
  const message = { tokens, data, android: { priority: "high" } };

  if (WITH_NOTIFICATION) {
    message.notification =
      TYPE === "activity"
        ? { title: data.title, body: data.body }
        : {
            title: data.isGroup === "true" ? data.conversationName : data.senderName,
            body:
              data.isGroup === "true"
                ? `${data.senderName}: ${data.body}`
                : data.body,
          };
    message.android.notification = {
      // _v2 because a channel's sound is immutable after creation - the v1
      // channels shipped with the default system tone, so the Chatterloop
      // tones required new ids. Keep in sync with NotificationRenderer.
      channelId:
        TYPE === "activity"
          ? "chatterloop_activity_v2"
          : "chatterloop_messages_v2",
      // res/raw/<name>.mp3, named WITHOUT the extension. Only honoured on
      // Android 7 and below; from 8 up the channel's own sound wins, which is
      // why the channel has to carry it too.
      sound:
        TYPE === "activity" ? "notification_alert" : "message_alert",
      // FCM's notification block has an `image` (a BigPicture banner shown
      // when the notification is expanded) but NO large-icon field - there is
      // no way to get a circular sender avatar out of an OS-rendered push.
      // Avatars come from MessagingStyle's Person.icon, which only exists on
      // the app-rendered (data-only) path.
      ...(flag("image") ? { imageUrl: flag("image") } : {}),
      // Successive pushes for the same conversation replace each other rather
      // than stacking - the one bit of Messenger-like behaviour available
      // without the app doing the rendering.
      ...(data.conversationId ? { tag: data.conversationId } : {}),
    };
  }

  const response = await firebase.messaging().sendEachForMulticast(message);

  console.log(
    `\nSent: ${response.successCount} ok, ${response.failureCount} failed.`,
  );

  response.responses.forEach((r, i) => {
    const short = `…${String(tokens[i]).slice(-12)}`;
    if (r.success) {
      console.log(`  ok      ${short}  ${r.messageId}`);
      return;
    }
    console.log(`  FAILED  ${short}  ${r.error?.code}: ${r.error?.message}`);
    // The one worth acting on: the token is dead (app uninstalled, data
    // cleared, token rotated). A real send path nulls it here.
    if (r.error?.code === "messaging/registration-token-not-registered") {
      console.log("          ^ dead token - production would null this row");
    }
  });
}

main()
  .catch((err) => {
    console.error("\nSend failed:", err.message);
    if (err.errorInfo) console.error(err.errorInfo);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState) await mongoose.disconnect();
    await firebase.app().delete();
  });
