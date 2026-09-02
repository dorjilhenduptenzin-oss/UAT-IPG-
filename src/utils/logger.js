const { maskValue } = require("./mask");

function sanitizeObject(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((v) => sanitizeObject(v));

  const output = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object") {
      output[k] = sanitizeObject(v);
    } else {
      output[k] = maskValue(k, v);
    }
  }
  return output;
}

function logInfo(message, payload) {
  if (payload === undefined) {
    console.log(`[INFO] ${message}`);
    return;
  }
  console.log(`[INFO] ${message}`, sanitizeObject(payload));
}

function logError(message, payload) {
  if (payload === undefined) {
    console.error(`[ERROR] ${message}`);
    return;
  }
  console.error(`[ERROR] ${message}`, sanitizeObject(payload));
}

module.exports = {
  sanitizeObject,
  logInfo,
  logError
};
