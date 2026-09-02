const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { toBase64Url, fromBase64Url } = require("../utils/base64url");

function generateRsa2048KeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: "spki",
      format: "der"
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem"
    }
  });

  return {
    publicKeyDer: publicKey,
    publicKeyBase64Url: toBase64Url(publicKey),
    privateKeyPem: privateKey
  };
}

function derivePublicKeyFromPrivatePem(privateKeyPem) {
  const privateKeyObj = crypto.createPrivateKey(privateKeyPem);
  const publicKeyObj = crypto.createPublicKey(privateKeyObj);
  const publicKeyDer = publicKeyObj.export({ type: "spki", format: "der" });
  return {
    publicKeyDer,
    publicKeyBase64Url: toBase64Url(publicKeyDer)
  };
}

function readPrivateKeyFromPath(pemPath) {
  const absolute = path.resolve(pemPath);
  if (!fs.existsSync(absolute)) {
    return null;
  }
  return fs.readFileSync(absolute, "utf8");
}

function signSha256WithRsa(privateKeyPem, utf8Input) {
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(utf8Input, "utf8");
  signer.end();
  const signature = signer.sign(privateKeyPem);
  return toBase64Url(signature);
}

function verifySha256WithRsa(publicKeyDerBase64Url, utf8Input, signatureBase64Url) {
  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(utf8Input, "utf8");
  verifier.end();
  const pubDer = fromBase64Url(publicKeyDerBase64Url);
  const pubObj = crypto.createPublicKey({ key: pubDer, format: "der", type: "spki" });
  const signatureBuffer = fromBase64Url(signatureBase64Url);
  return verifier.verify(pubObj, signatureBuffer);
}

function fingerprintPublicKeyBase64Url(publicKeyBase64Url) {
  const derBuffer = fromBase64Url(publicKeyBase64Url);
  return crypto.createHash("sha256").update(derBuffer).digest("hex");
}

module.exports = {
  generateRsa2048KeyPair,
  derivePublicKeyFromPrivatePem,
  readPrivateKeyFromPath,
  signSha256WithRsa,
  verifySha256WithRsa,
  fingerprintPublicKeyBase64Url
};
