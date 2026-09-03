const path = require("path");
const dotenv = require("dotenv");
const { UAT_3DSS_CONFIG } = require("./uat3dss");

dotenv.config();

const ENVIRONMENT = "UAT";
const MODE = process.env.MODE === "MOCK" ? "MOCK" : "UAT";
const IS_SERVERLESS_RUNTIME = Boolean(
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT
);
const UAT_MERCHANT_ID = "863990035600270";
const STABLE_UAT_BASE_URL = "https://uatipg.vercel.app";

// Every merchant ID the tool is allowed to transact as. A merchant ID only
// works if Cardzone has it in BOTH the acquirer system and the MPI enrol
// screen; sending an un-enrolled ID returns "503 Invalid Merchant". Override
// with UAT_ENROLLED_MERCHANT_IDS (comma separated) once Cardzone confirms
// which IDs are live in UAT.
const DEFAULT_ENROLLED_MERCHANT_IDS = ["863990035600270", "863990026500270"];
const UAT_ENROLLED_MERCHANT_IDS = (
  process.env.UAT_ENROLLED_MERCHANT_IDS || DEFAULT_ENROLLED_MERCHANT_IDS.join(",")
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const BOOL_TRUE = new Set(["1", "true", "TRUE", "yes", "YES"]);

function toBool(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  return BOOL_TRUE.has(String(value));
}

function toInt(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  const n = Number.parseInt(String(value), 10);
  if (Number.isNaN(n)) {
    return defaultValue;
  }
  return n;
}

const config = Object.freeze({
  ENVIRONMENT,
  MODE,
  APP_VERSION:
    process.env.APP_VERSION ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.npm_package_version ||
    "dev",
  PORT: 3000,
  BIND_HOST: process.env.BIND_HOST || "0.0.0.0",
  MERCHANT_ID: process.env.MERCHANT_ID || UAT_MERCHANT_ID,
  UAT_ENROLLED_MERCHANT_IDS,
  // Static last-resort key for verifying the MPIRes / callback MAC. Cardzone's
  // UAT mkReq returns a DIFFERENT public key per transaction, so a static value
  // here will normally NOT match a given callback - the authoritative source is
  // the per-transaction key captured at mkReq time and kept in the durable
  // store. Leave empty unless Cardzone confirms a stable per-merchant key.
  CARDZONE_PUBLIC_KEY: process.env.CARDZONE_PUBLIC_KEY || "",
  CALLBACK_BASE_URL: process.env.CALLBACK_BASE_URL || STABLE_UAT_BASE_URL,
  RETURN_BASE_URL: process.env.RETURN_BASE_URL || process.env.CALLBACK_BASE_URL || STABLE_UAT_BASE_URL,
  CARDZONE_MKREQ_URL: process.env.CARDZONE_MKREQ_URL || UAT_3DSS_CONFIG.mkReqUrl,
  CARDZONE_MERC_REQ_URL: process.env.CARDZONE_MERC_REQ_URL || UAT_3DSS_CONFIG.mercReqUrl,
  CARDZONE_INQUIRY_URL: process.env.CARDZONE_INQUIRY_URL || UAT_3DSS_CONFIG.mercReqUrl,
  ENABLE_MKREQ_MAC: toBool(process.env.ENABLE_MKREQ_MAC, false),
  MPI_MAC_INCLUDE_RESPONSE_TYPE: toBool(process.env.MPI_MAC_INCLUDE_RESPONSE_TYPE, false),
  // The MPI_MAC is signed over exactly the MPI_PURCH_DATE that is sent on the
  // wire (Cardzone rebuilds the canonical string from the received fields).
  // Leave this empty. It only exists as an escape hatch if Cardzone ever
  // confirms they normalise the timestamp to a specific zone before checking
  // the MAC; setting it to ASIA_THIMPHU would shift the signed value +6h.
  MPI_MAC_PURCHASE_DATE_TIMEZONE: process.env.MPI_MAC_PURCHASE_DATE_TIMEZONE || "",
  MERCHANT_PRIVATE_KEY_PEM_PATH:
    process.env.MERCHANT_PRIVATE_KEY_PEM_PATH ||
    path.join(process.cwd(), "data", "keys", "merchant_private.pem"),
  USE_CARDZONE_PROXY: toBool(process.env.USE_CARDZONE_PROXY, !IS_SERVERLESS_RUNTIME),
  CARDZONE_PROXY_HOST: process.env.CARDZONE_PROXY_HOST || UAT_3DSS_CONFIG.proxyServer,
  CARDZONE_PROXY_PORT: toInt(process.env.CARDZONE_PROXY_PORT, UAT_3DSS_CONFIG.proxyPort),
  HTTP_PROXY: process.env.HTTP_PROXY || "",
  HTTPS_PROXY: process.env.HTTPS_PROXY || ""
});

if (process.env.ENVIRONMENT && process.env.ENVIRONMENT !== "UAT") {
  throw new Error("Only ENVIRONMENT=UAT is allowed for this tool.");
}

if (!/^\d{15}$/.test(config.MERCHANT_ID)) {
  throw new Error("MERCHANT_ID must be a 15-digit numeric Cardzone merchant ID.");
}

if (!UAT_ENROLLED_MERCHANT_IDS.includes(config.MERCHANT_ID)) {
  throw new Error(
    `MERCHANT_ID ${config.MERCHANT_ID} is not listed in UAT_ENROLLED_MERCHANT_IDS ` +
      `(${UAT_ENROLLED_MERCHANT_IDS.join(", ")}). Confirm the ID is enrolled in ` +
      "Cardzone's acquirer system and MPI enrol screen before using it."
  );
}

if (!config.CARDZONE_MKREQ_URL.includes("uat")) {
  throw new Error("CARDZONE_MKREQ_URL must be a UAT endpoint.");
}
if (!config.CARDZONE_MERC_REQ_URL.includes("uat")) {
  throw new Error("CARDZONE_MERC_REQ_URL must be a UAT endpoint.");
}
if (!config.CARDZONE_INQUIRY_URL.includes("uat")) {
  throw new Error("CARDZONE_INQUIRY_URL must be a UAT endpoint.");
}

if (MODE === "UAT") {
  if (IS_SERVERLESS_RUNTIME && config.USE_CARDZONE_PROXY) {
    console.warn(
      "[WARN] USE_CARDZONE_PROXY=true on serverless runtime. Ensure the proxy is publicly reachable from deployment environment."
    );
  }
  try {
    const callbackHost = new URL(config.CALLBACK_BASE_URL).hostname;
    if (["localhost", "127.0.0.1"].includes(callbackHost)) {
      // Explicit warning to avoid confusion between browser return and server callback reachability.
      console.warn(
        "[WARN] CALLBACK_BASE_URL points to localhost. Remote Cardzone servers cannot call localhost for server-to-server callback."
      );
    }
  } catch {
    // Ignore malformed optional URL values here; endpoint checks happen at use sites.
  }
}

module.exports = {
  config
};
