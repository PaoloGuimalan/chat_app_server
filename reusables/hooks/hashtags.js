// Hashtags written into a post caption, turned into interests.
//
// WHY THIS RUNS AT CREATION TIME
// ------------------------------
// A hashtag is the one tag that needs no model to read. The author typed it
// outright, which makes it the strongest signal the platform has about what
// their post is for, and extracting it is a regular expression.
//
// queueContentTagging() in reusables/models/posts.js also promotes hashtags,
// but only when the moderation service is ONLINE - it is gated on a Redis
// presence key and publishes nothing when that key is absent, leaving the work
// to that service's next database scour. That is the right trade for
// captioning an image. It is the wrong one for a hashtag, which should be
// registered by the time the author's post appears.
//
// WHAT THIS DELIBERATELY DOES NOT DO
// ----------------------------------
// It does not touch interests_entityinterestaffinity or
// interests_interesttrendingscore. Those are SCORES, and scores double-count
// when two writers both believe they own them. The moderation service's
// interest sink is the single writer for both and reaches this same post
// either by queue or by scour - exactly once. This writes only what is
// idempotent by construction: an interest row keyed on a unique
// normalized_name, and a link row under the unique (post_id, interest_id)
// constraint. Both paths running over one post therefore converge instead of
// inflating.
//
// FOUR IMPLEMENTATIONS HAVE TO AGREE
// ----------------------------------
// Same hazard reusables/hooks/transformers.js documents for @mentions, one
// participant worse:
//
//   - moderation_service/core/vocabulary.py     hashtags()   <- canonical
//   - user_service/interests/services/hashtags.py
//   - webapp/src/reusables/hooks/hashtags.ts
//   - this file
//
// Disagreement does not throw. It quietly creates a second interest for a tag
// that already exists, which is the duplication the normalized key was
// introduced to prevent.

// Unicode classes rather than \w, and this is not pedantry: Python's \w
// matches accented letters and JavaScript's does not, so "#café" would be one
// interest on the Django side and a different one here. \p{L}\p{N} is what
// makes the two agree, and the "u" flag is required for it to mean anything.
//
// The lookbehind excludes an HTML numeric entity. This platform stores
// authored text escaped, so "didn&#039;t" contains "#039", which a bare
// "#\w+" matched well enough to be saved as a declared interest. A "#"
// preceded by "&" is punctuation. Excluding a preceding word character also
// rules out a URL fragment - "example.com/page#section" is an address, not
// something anybody tagged.
const HASHTAG_PATTERN = /(?<![&\p{L}\p{N}_])#([\p{L}\p{N}_-]{2,50})/gu;

// Hyphens and underscores inside a hashtag are word separators: "#north-edsa"
// and "#docker_swarm" mean the multi-word interests they obviously mean.
// Applied ONLY here - doing it during normalisation would corrupt a
// legitimately hyphenated interest name such as "e-commerce".
const SEPARATOR_RUN = /[-_]+/g;

const WHITESPACE_RUN = /\s+/g;

const HAS_LETTER = /\p{L}/u;

/** The readable form stored in interests_interest.name - spaces kept. */
const displayName = (value) => String(value ?? "").trim().replace(WHITESPACE_RUN, " ");

/**
 * The key form stored in interests_interest.normalized_name - spaces removed
 * entirely, lowercased.
 *
 * Mirrors user_service interests/models.py normalize_key() EXACTLY. A key
 * derived differently here matches nothing and then creates a duplicate of the
 * row it failed to find.
 */
const normalizeKey = (value) =>
  displayName(value).replace(WHITESPACE_RUN, "").toLowerCase();

/**
 * Readable interest names for every hashtag in `text`, in order, deduplicated.
 *
 * "#north-edsa" gives "north edsa" - the readable form, not the squashed key.
 * Both identify the same interest because normalizeKey() removes the spaces
 * again, but only one of them is fit to display once the hashtag is new and
 * becomes a row somebody later reads in the UI.
 */
const extractHashtags = (text) => {
  if (!text) return [];

  const seen = new Set();
  const names = [];

  for (const match of String(text).matchAll(HASHTAG_PATTERN)) {
    const raw = match[1];

    // At least one letter. "#2024" is a year and "#1" is a rank; neither is an
    // interest, and the taxonomy should not grow one.
    if (!HAS_LETTER.test(raw)) continue;

    const readable = displayName(raw.replace(SEPARATOR_RUN, " "));
    const key = normalizeKey(readable);
    if (key && !seen.has(key)) {
      seen.add(key);
      names.push(readable);
    }
  }

  return names;
};

/**
 * Resolve one interest by name, creating it when it is new. Returns its id.
 *
 * The CTE is an upsert that reads back the id in BOTH cases. The obvious
 * alternative - ON CONFLICT DO UPDATE purely so RETURNING fires - rewrites the
 * row on every post that reuses a popular tag, taking a row lock and leaving a
 * dead tuple behind for work that changes nothing. DO NOTHING plus a UNION ALL
 * read costs neither.
 *
 * Conflicts are resolved on normalized_name. interests_interest also has a
 * UNIQUE on name, but that cannot be hit independently: identical names
 * normalise identically, so a name collision is always a key collision first
 * and is caught here before the insert is attempted.
 */
const resolveInterest = async (client, name) => {
  const readable = displayName(name);
  const key = normalizeKey(readable);
  if (!key) return null;

  const { rows } = await client.query(
    `WITH inserted AS (
       INSERT INTO interests_interest (name, normalized_name, created_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (normalized_name) DO NOTHING
       RETURNING id
     )
     SELECT id FROM inserted
     UNION ALL
     SELECT id FROM interests_interest WHERE normalized_name = $2
     LIMIT 1`,
    [readable, key],
  );

  return rows.length > 0 ? rows[0].id : null;
};

/**
 * Link every hashtag in `caption` to `postID`. Returns the names linked.
 *
 * Call INSIDE the post's transaction, passing its client: a tag belongs to the
 * post, and a rolled-back post must not leave links behind pointing at a row
 * that was never committed.
 *
 * THROWS on a database error, and that is the deliberate choice. Failing a
 * statement inside a transaction aborts it in Postgres, so there is no
 * "continue without tags" to fall back to - every later query on this client
 * would fail anyway, and swallowing here would surface the problem somewhere
 * unrelated. The caller already wraps this in try/ROLLBACK.
 */
const savePostHashtags = async (client, postID, caption) => {
  const names = extractHashtags(caption);
  if (names.length === 0) return [];

  const linked = [];

  try {
    for (const name of names) {
      const interestID = await resolveInterest(client, name);
      if (interestID === null) continue;

      await client.query(
        `INSERT INTO interests_postinterestlink
           (post_id, interest_id, source, confidence, created_at)
         VALUES ($1, $2, 'hashtag', NULL, NOW())
         ON CONFLICT (post_id, interest_id) DO NOTHING`,
        [String(postID), interestID],
      );
      linked.push(name);
    }
  } catch (error) {
    console.error("savePostHashtags failed:", error);
    // Rethrown deliberately: this runs inside the caller's transaction, and a
    // failed statement has already aborted it in Postgres. Swallowing here
    // would leave the caller issuing further queries against a dead
    // transaction and reporting a confusing error from somewhere else.
    throw error;
  }

  return linked;
};

module.exports = {
  extractHashtags,
  savePostHashtags,
  displayName,
  normalizeKey,
};
