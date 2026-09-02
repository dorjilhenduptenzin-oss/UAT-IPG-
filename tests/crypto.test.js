const {
  generateRsa2048KeyPair,
  derivePublicKeyFromPrivatePem,
  signSha256WithRsa,
  verifySha256WithRsa
} = require("../src/crypto/rsa");
const { toBase64Url } = require("../src/utils/base64url");

test("RSA-2048 generation works", () => {
  const keys = generateRsa2048KeyPair();
  expect(keys.privateKeyPem).toContain("BEGIN PRIVATE KEY");
  expect(keys.publicKeyBase64Url.length).toBeGreaterThan(300);
});

test("public-key Base64URL has no plus slash equals", () => {
  const keys = generateRsa2048KeyPair();
  expect(keys.publicKeyBase64Url).not.toMatch(/[+/=]/);
});

test("base64url helper strips plus slash equals", () => {
  const out = toBase64Url(Buffer.from([251, 255, 239]));
  expect(out).toBe("-__v");
});

test("SHA256withRSA signing verifies with same key", () => {
  const keys = generateRsa2048KeyPair();
  const sig = signSha256WithRsa(keys.privateKeyPem, "abc123");
  const ok = verifySha256WithRsa(keys.publicKeyBase64Url, "abc123", sig);
  expect(ok).toBe(true);
});

test("different key pair fails verification", () => {
  const k1 = generateRsa2048KeyPair();
  const k2 = generateRsa2048KeyPair();
  const sig = signSha256WithRsa(k1.privateKeyPem, "abc123");
  const ok = verifySha256WithRsa(k2.publicKeyBase64Url, "abc123", sig);
  expect(ok).toBe(false);
});

test("derived public key from private key verifies signature", () => {
  const keys = generateRsa2048KeyPair();
  const derived = derivePublicKeyFromPrivatePem(keys.privateKeyPem);
  const sig = signSha256WithRsa(keys.privateKeyPem, "diagnostic payload");
  const ok = verifySha256WithRsa(derived.publicKeyBase64Url, "diagnostic payload", sig);
  expect(ok).toBe(true);
});
