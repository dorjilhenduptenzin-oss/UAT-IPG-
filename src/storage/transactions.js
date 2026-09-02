const fs = require("fs");
const path = require("path");
const { getDataRootDir } = require("./paths");

const TRANSACTION_DIR = path.join(getDataRootDir(), "transactions");

function ensureDir() {
  fs.mkdirSync(TRANSACTION_DIR, { recursive: true });
}

function getTxnPath(txnId) {
  return path.join(TRANSACTION_DIR, `txn_${txnId}.json`);
}

function saveTransaction(txn) {
  ensureDir();
  const filePath = getTxnPath(txn.txnId);
  fs.writeFileSync(filePath, JSON.stringify(txn, null, 2), "utf8");
  return filePath;
}

function loadTransaction(txnId) {
  const filePath = getTxnPath(txnId);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function transactionExists(txnId) {
  return fs.existsSync(getTxnPath(txnId));
}

function listRecentTransactions(limit = 50) {
  ensureDir();
  const files = fs.readdirSync(TRANSACTION_DIR).filter((f) => f.startsWith("txn_"));
  const txns = files
    .map((f) => {
      const p = path.join(TRANSACTION_DIR, f);
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      return raw;
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return txns.slice(0, limit);
}

module.exports = {
  saveTransaction,
  loadTransaction,
  transactionExists,
  listRecentTransactions,
  TRANSACTION_DIR
};
