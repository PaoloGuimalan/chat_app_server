const { randomInt } = require("crypto");

// `length` random decimal digits. crypto.randomInt rather than Math.random:
// these ids end up in public file URLs and message ids, and Math.random's
// output can be predicted from enough earlier values.
function makeid(length) {
  let result = "";
  for (let i = 0; i < length; i++) {
    result += randomInt(10);
  }
  return result;
}

module.exports = makeid;
