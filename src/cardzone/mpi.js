const { MPI_MAC_FIELD_ORDER, CALLBACK_MAC_FIELD_ORDER } = require("./fields");
const { signSha256WithRsa, verifySha256WithRsa } = require("../crypto/rsa");
const { sha256Hex } = require("../utils/hash");
const { config } = require("../config/env");

const PURCHASE_DATE_TIME_ZONE = "Asia/Thimphu";
const MPI_MAC_PURCHASE_DATE_TZ_ASIA_THIMPHU = "ASIA_THIMPHU";
const ASIA_THIMPHU_OFFSET_MINUTES = 6 * 60;
const purchaseDateFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: PURCHASE_DATE_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});

function formatUtcPurchaseDate(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const second = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}${hour}${minute}${second}`;
}

function parsePurchaseDateAsUtc(wirePurchaseDate) {
  const raw = String(wirePurchaseDate || "");
  if (!/^\d{14}$/.test(raw)) {
    throw new Error("MPI_PURCH_DATE must be a 14-digit yyyyMMddHHmmss string.");
  }
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  const hour = Number(raw.slice(8, 10));
  const minute = Number(raw.slice(10, 12));
  const second = Number(raw.slice(12, 14));
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

function formatUtcDateParts(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const second = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}${hour}${minute}${second}`;
}

function formatPurchaseDate(date = new Date()) {
  const parts = purchaseDateFormatter.formatToParts(date);
  const partMap = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return `${partMap.year}${partMap.month}${partMap.day}${partMap.hour}${partMap.minute}${partMap.second}`;
}

function canonicalMpiPurchaseDateForCardzoneMac(wirePurchaseDate, options = {}) {
  const timezoneMode =
    options.purchaseDateTimezone !== undefined
      ? options.purchaseDateTimezone
      : config.MPI_MAC_PURCHASE_DATE_TIMEZONE;

  if (!timezoneMode) {
    return String(wirePurchaseDate || "");
  }

  if (timezoneMode === MPI_MAC_PURCHASE_DATE_TZ_ASIA_THIMPHU) {
    const utcDate = parsePurchaseDateAsUtc(wirePurchaseDate);
    const thimphuInstant = new Date(utcDate.getTime() + ASIA_THIMPHU_OFFSET_MINUTES * 60 * 1000);
    return formatUtcDateParts(thimphuInstant);
  }

  throw new Error(`Unsupported MPI_MAC_PURCHASE_DATE_TIMEZONE: ${timezoneMode}`);
}

function buildMpiLineItem(lineItems = []) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return "";
  }
  return lineItems
    .map((item) => {
      const id = item.MPI_ITEM_ID || "";
      const remark = item.MPI_ITEM_REMARK || "";
      const quantity = item.MPI_ITEM_QUANTITY || "";
      const amount = item.MPI_ITEM_AMOUNT || "";
      const currency = item.MPI_ITEM_CURRENCY || "";
      return `${id};${remark};${quantity};${amount};${currency}`;
    })
    .join("");
}

function getMpiReqMacFieldSequence(options = {}) {
  const includeResponseType =
    options.includeResponseType !== undefined
      ? options.includeResponseType
      : config.MPI_MAC_INCLUDE_RESPONSE_TYPE;
  if (includeResponseType) {
    return MPI_MAC_FIELD_ORDER;
  }
  return MPI_MAC_FIELD_ORDER.filter((field) => field !== "MPI_RESPONSE_TYPE");
}

function normalizeMpiFieldsForMac(mpiFields, options = {}) {
  return {
    ...mpiFields,
    MPI_PURCH_DATE: canonicalMpiPurchaseDateForCardzoneMac(mpiFields.MPI_PURCH_DATE, options)
  };
}

function canonicalMpiMacInput(mpiFields, options = {}) {
  const normalizedFields = normalizeMpiFieldsForMac(mpiFields, options);
  return getMpiReqMacFieldSequence(options)
    .map((field) => (normalizedFields[field] ?? ""))
    .join("");
}

function generateMpiMac(privateKeyPem, mpiFields, options = {}) {
  const input = canonicalMpiMacInput(mpiFields, options);
  return {
    input,
    inputHash: sha256Hex(input),
    signature: signSha256WithRsa(privateKeyPem, input)
  };
}

function verifyMpiMac(publicKeyBase64Url, mpiFields, mac, options = {}) {
  const input = canonicalMpiMacInput(mpiFields, options);
  const ok = verifySha256WithRsa(publicKeyBase64Url, input, mac);
  return {
    ok,
    input,
    inputHash: sha256Hex(input)
  };
}

function canonicalCallbackMacInput(callbackFields) {
  return CALLBACK_MAC_FIELD_ORDER.map((field) => callbackFields[field] ?? "").join("");
}

function verifyCallbackMac(publicKeyBase64Url, callbackFields, callbackMac) {
  const input = canonicalCallbackMacInput(callbackFields);
  const ok = verifySha256WithRsa(publicKeyBase64Url, input, callbackMac || "");
  return {
    ok,
    input,
    inputHash: sha256Hex(input)
  };
}

module.exports = {
  PURCHASE_DATE_TIME_ZONE,
  MPI_MAC_PURCHASE_DATE_TZ_ASIA_THIMPHU,
  formatUtcPurchaseDate,
  formatPurchaseDate,
  canonicalMpiPurchaseDateForCardzoneMac,
  buildMpiLineItem,
  getMpiReqMacFieldSequence,
  canonicalMpiMacInput,
  generateMpiMac,
  verifyMpiMac,
  canonicalCallbackMacInput,
  verifyCallbackMac
};
