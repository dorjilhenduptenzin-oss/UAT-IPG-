const axios = require("axios");
const assert = require("assert");
const crypto = require("crypto");
const { config } = require("../config/env");
const { logInfo } = require("../utils/logger");
const { fromBase64Url } = require("../utils/base64url");

function buildAxiosConfig() {
  const timeoutMs = 10000;
  if (!config.USE_CARDZONE_PROXY) {
    return {
      timeout: timeoutMs,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      }
    };
  }

  return {
    timeout: timeoutMs,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    proxy: {
      host: config.CARDZONE_PROXY_HOST,
      port: config.CARDZONE_PROXY_PORT,
      protocol: "http"
    }
  };
}

async function doMkReq(payload) {
  const started = Date.now();
  const axiosConfig = buildAxiosConfig();

  // Serialize exactly once so the wire payload is always a JSON object string.
  const body = JSON.stringify(payload);
  JSON.parse(body);
  assert(body.startsWith("{"));
  assert(body.endsWith("}"));

  const bodyHash = crypto.createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
  const safePayload = {
    merchantId: payload.merchantId,
    purchaseId: payload.purchaseId,
    pubKey: "<redacted>"
  };

  logInfo("MKREQ HTTP DEBUG", {
    mkreqUrl: config.CARDZONE_MKREQ_URL,
    mkreqMethod: "POST",
    mkreqContentType: "application/json",
    mkreqAccept: "application/json",
    mkreqContentLength: Buffer.byteLength(body, "utf8"),
    mkreqBodyFirstCharacter: body[0],
    mkreqBodyLastCharacter: body[body.length - 1],
    mkreqBodySha256: bodyHash,
    mkreqBodySafe: safePayload,
    publicKeyFingerprintSha256: crypto
      .createHash("sha256")
      .update(fromBase64Url(payload.pubKey || ""))
      .digest("hex")
  });

  const response = await axios.post(config.CARDZONE_MKREQ_URL, body, {
    ...axiosConfig,
    headers: {
      ...axiosConfig.headers,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Content-Length": String(Buffer.byteLength(body, "utf8"))
    }
  });

  return {
    status: response.status,
    elapsedMs: Date.now() - started,
    data: response.data
  };
}

async function doFormPost(url, formFields) {
  const started = Date.now();
  const body = new URLSearchParams(formFields).toString();
  const axiosConfig = buildAxiosConfig();
  const response = await axios.post(url, body, {
    ...axiosConfig,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    }
  });

  return {
    status: response.status,
    elapsedMs: Date.now() - started,
    data: response.data
  };
}

module.exports = {
  doMkReq,
  doFormPost
};
