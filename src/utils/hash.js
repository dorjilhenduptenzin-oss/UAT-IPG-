const crypto = require("crypto");

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

module.exports = {
  sha256Hex
};
