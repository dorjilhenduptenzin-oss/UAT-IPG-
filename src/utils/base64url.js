function toBase64Url(inputBuffer) {
  return Buffer.from(inputBuffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(input) {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = `${b64}${"=".repeat((4 - (b64.length % 4)) % 4)}`;
  return Buffer.from(padded, "base64");
}

module.exports = {
  toBase64Url,
  fromBase64Url
};
