require("dotenv").config();
const crypto = require("crypto");
const JWT_SECRET = process.env.JWT_SECRET;

function decryptNonce(receivedNonce) {
  try {
    const [ivHex, cipherTextHex] = receivedNonce.split(".");
    if (!ivHex || !cipherTextHex) throw new Error("Malformed nonce format");

    const key = crypto.createHash("sha256").update(JWT_SECRET).digest();

    const iv = Buffer.from(ivHex, "hex");
    const encryptedData = Buffer.from(cipherTextHex, "hex");

    const tag = encryptedData.subarray(-16);
    const ciphertext = encryptedData.subarray(0, -16);

    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);

    const decrypted =
      decipher.update(ciphertext, "binary", "utf8") + decipher.final("utf8");

    const [userId, timestamp, random] = decrypted.split(".");

    return { userId, timestamp: parseInt(timestamp), random };
  } catch (err) {
    console.error("Nonce Decryption Failed:", err.message);
    return null;
  }
}

module.exports = {
  decryptNonce,
};
