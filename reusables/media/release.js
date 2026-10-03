/**
 * Publishing that a post / comment / message (or a replaced avatar) is gone,
 * along with the files it used. The deciding and deleting is background work,
 * so it lives in worker_service (internal/services/media): kept while
 * anything live uses a file, held if its content was reported, otherwise
 * removed from storage. user_service publishes the same job.
 *
 *   { items: [{ target: { type: "post" | "comment" | "message" | ..., id },
 *               urls: [...],
 *               context?: { conversationID } }] }
 */
const { publish, QUEUES } = require("../rabbitmq/workqueue");

/** The URL half of a stored message/reference value ("url%%%name" in old rows). */
const urlOf = (value) =>
  typeof value === "string" ? value.split("%%%")[0].trim() : "";

/** Hands a release job to the worker. Best-effort, never throws. */
const publishRelease = (items) => {
  const clean = (items || [])
    .map((item) => ({
      ...item,
      urls: [...new Set((item.urls || []).map(urlOf).filter(Boolean))],
    }))
    .filter((item) => item.urls.length);
  if (!clean.length) return Promise.resolve(false);
  return publish(QUEUES.MEDIA_RELEASE, { items: clean });
};

module.exports = { publishRelease, urlOf };
