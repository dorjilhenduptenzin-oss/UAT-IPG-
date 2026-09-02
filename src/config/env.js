const path = require("path");
const dotenv = require("dotenv");
const { UAT_3DSS_CONFIG } = require("./uat3dss");

dotenv.config();

const ENVIRONMENT = "UAT";
const MODE = process.env.MODE === "MOCK" ? "MOCK" : "UAT";
const IS_SERVERLESS_RUNTIME = Boolean(
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT
);

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
  PORT: toInt(process.env.PORT, 3000),
  BIND_HOST: process.env.BIND_HOST || "0.0.0.0",
  MERCHANT_ID: process.env.MERCHANT_ID || "863990030700270",
  CALLBACK_BASE_URL: process.env.CALLBACK_BASE_URL || "http://localhost:3000",
  RETURN_BASE_URL: process.env.RETURN_BASE_URL || process.env.CALLBACK_BASE_URL || "http://localhost:3000",
  CARDZONE_MKREQ_URL: process.env.CARDZONE_MKREQ_URL || UAT_3DSS_CONFIG.mkReqUrl,
  CARDZONE_MERC_REQ_URL: process.env.CARDZONE_MERC_REQ_URL || UAT_3DSS_CONFIG.mercReqUrl,
  CARDZONE_INQUIRY_URL: process.env.CARDZONE_INQUIRY_URL || UAT_3DSS_CONFIG.mercReqUrl,
  ENABLE_MKREQ_MAC: toBool(process.env.ENABLE_MKREQ_MAC, false),
  MPI_MAC_INCLUDE_RESPONSE_TYPE: toBool(process.env.MPI_MAC_INCLUDE_RESPONSE_TYPE, true),
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
