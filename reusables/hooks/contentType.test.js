/**
 * Run with:  node --test reusables/hooks/*.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { pickContentType, dispositionFor } = require("./contentType");
const makeid = require("./makeID");

test("the bytes decide the type when they identify themselves", () => {
  assert.equal(pickContentType("image/png", "image/jpeg"), "image/png");
  assert.equal(pickContentType("video/mp4", undefined), "video/mp4");
});

test("a sound-only container keeps the claimed audio type", () => {
  assert.equal(pickContentType("video/webm", "audio/webm"), "audio/webm");
  assert.equal(pickContentType("video/mp4", "audio/m4a"), "audio/m4a");
  // ...but only audio may override; anything else claimed loses to the bytes.
  assert.equal(pickContentType("video/mp4", "image/png"), "video/mp4");
});

test("an unsigned file takes the claimed type, unless it could run", () => {
  assert.equal(pickContentType(undefined, "text/plain"), "text/plain");
  assert.equal(pickContentType(undefined, "TEXT/CSV"), "text/csv");
  for (const active of [
    "text/html",
    "image/svg+xml",
    "application/xhtml+xml",
    "text/javascript",
    "application/xml",
  ]) {
    assert.equal(pickContentType(undefined, active), "application/octet-stream");
  }
});

test("a missing or malformed claim falls back to binary", () => {
  assert.equal(pickContentType(undefined, undefined), "application/octet-stream");
  assert.equal(pickContentType(null, ""), "application/octet-stream");
  assert.equal(
    pickContentType(null, "text/plain; charset=utf-8"),
    "application/octet-stream",
  );
});

test("photos, videos and audio open in place; SVG and documents download", () => {
  for (const inline of ["image/jpeg", "image/webp", "video/mp4", "audio/webm"]) {
    assert.equal(dispositionFor(inline, "x"), "inline");
  }
  assert.match(dispositionFor("image/svg+xml", "logo.svg"), /^attachment;/);
  assert.match(dispositionFor("application/pdf", "a.pdf"), /^attachment;/);
});

test("a download keeps its real name, non-ASCII included", () => {
  assert.equal(
    dispositionFor("application/pdf", "Report Q3.pdf"),
    `attachment; filename="Report Q3.pdf"; filename*=UTF-8''Report%20Q3.pdf`,
  );
  assert.equal(
    dispositionFor("text/plain", `Café "notes".txt`),
    `attachment; filename="Caf_ _notes_.txt"; filename*=UTF-8''Caf%C3%A9%20%22notes%22.txt`,
  );
  // RFC 5987 leaves ' ( ) * out of the allowed characters.
  assert.match(dispositionFor("text/plain", "it's (1).txt"), /it%27s%20%281%29\.txt$/);
  assert.match(dispositionFor("application/zip", ""), /filename="file"/);
});

test("makeid gives exactly `length` decimal digits", () => {
  for (const length of [1, 10, 30]) {
    const id = makeid(length);
    assert.equal(id.length, length);
    assert.match(id, /^\d+$/);
  }
  assert.notEqual(makeid(30), makeid(30));
});
