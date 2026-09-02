const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const FILE = path.join(process.cwd(), "data", "payment_links.json");

function ensureFile() {
  const dir = path.dirname(FILE);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify({ links: [] }, null, 2));
  }
}

function readAll() {
  ensureFile();
  return JSON.parse(fs.readFileSync(FILE, "utf8"));
}

function writeAll(data) {
  ensureFile();
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), "utf8");
}

function createPaymentLink(txnId, ttlMinutes = 30) {
  const token = crypto.randomBytes(8).toString("hex");
  const expiresAt = Date.now() + ttlMinutes * 60 * 1000;
  const db = readAll();
  db.links.push({ token, txnId, expiresAt, createdAt: new Date().toISOString() });
  writeAll(db);
  return { token, txnId, expiresAt };
}

function getPaymentLink(token) {
  const db = readAll();
  const found = db.links.find((l) => l.token === token);
  if (!found) return null;
  if (Date.now() > found.expiresAt) return null;
  return found;
}

module.exports = {
  createPaymentLink,
  getPaymentLink
};
