const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  generateRsa2048KeyPair,
  derivePublicKeyFromPrivatePem,
  readPrivateKeyFromPath,
  fingerprintPublicKeyBase64Url,
  verifySha256WithRsa
} = require("../crypto/rsa");
const { doMkReq, doFormPost } = require("../cardzone/client");
const {
  formatPurchaseDate,
  canonicalMpiPurchaseDateForCardzoneMac,
  buildMpiLineItem,
  generateMpiMac,
  verifyCallbackMac,
  canonicalMpiMacInput
} = require("../cardzone/mpi");
const { sha256Hex } = require("../utils/hash");
const { maskPan } = require("../utils/mask");
const { logInfo } = require("../utils/logger");
const { config } = require("../config/env");
const { UAT_3DSS_CONFIG } = require("../config/uat3dss");
const { getDataRootDir } = require("../storage/paths");
const {
  saveTransaction,
  loadTransaction,
  transactionExists,
  listRecentTransactions,
  hydrateFromDurable,
  persistToDurable
} = require("../storage/transactions");
const { durableEnabled, durableGet, durableSet } = require("../storage/durable");

const keyRegistry = new Map();
const runtimeMpiRegistry = new Map();
const MAC_WIRE_PURCHASE_DATE_OPTIONS = Object.freeze({ purchaseDateTimezone: null });
const DURABLE_KEY_PREFIX = "uat:key:";

const CURRENCY_CONFIG = Object.freeze({
  "840": { alpha: "USD", minorDigits: 2 },
  "356": { alpha: "INR", minorDigits: 2 },
  "064": { alpha: "BTN", minorDigits: 2 }
});

const PURCHASE_ID_REGEX = /^\d{19}$/;
const PURCHASE_ID_FORMAT_DESC = "YYYYMMDDHHmmss + 5 numeric digits (19 chars total)";

function getTxnPrivateKeyPath(txnId) {
  return path.join(getDataRootDir(), "keys", `private_${txnId}.pem`);
}

function persistGeneratedPrivateKey(txnId, privateKeyPem) {
  const keyPath = getTxnPrivateKeyPath(txnId);
  const keyDir = path.dirname(keyPath);
  fs.mkdirSync(keyDir, { recursive: true });
  fs.writeFileSync(keyPath, privateKeyPem, { encoding: "utf8", mode: 0o600 });
  return keyPath;
}

function loadTxnPrivateKey(txnId) {
  const keyPath = getTxnPrivateKeyPath(txnId);
  if (!fs.existsSync(keyPath)) return null;
  return fs.readFileSync(keyPath, "utf8");
}

/**
 * Pull the per-transaction signing key from the durable store into the local
 * key registry. Needed so the inquiry MAC (signed after the browser has left
 * the merchant) can still be produced on a cold serverless invocation.
 */
async function hydrateKeyRegistry(txnId) {
  if (!durableEnabled() || !txnId || keyRegistry.has(txnId)) {
    return;
  }
  const record = await durableGet(DURABLE_KEY_PREFIX + txnId);
  if (record && record.privateKeyPem && record.publicKeyBase64Url) {
    keyRegistry.set(txnId, {
      privateKeyPem: record.privateKeyPem,
      publicKeyBase64Url: record.publicKeyBase64Url
    });
  }
}

async function persistKeyRegistry(txnId) {
  if (!durableEnabled() || !txnId) {
    return;
  }
  const record = keyRegistry.get(txnId);
  if (record && record.privateKeyPem && record.publicKeyBase64Url) {
    await durableSet(DURABLE_KEY_PREFIX + txnId, {
      privateKeyPem: record.privateKeyPem,
      publicKeyBase64Url: record.publicKeyBase64Url
    });
  }
}

/**
 * Rehydrate every piece of cross-invocation state for a transaction (record +
 * signing key) before a synchronous service call reads it. Call sites are the
 * async route handlers and the async service entry points (runMkReq / runInquiry).
 */
async function hydrateDurableState(txnId) {
  if (!txnId) return;
  await hydrateFromDurable(txnId);
  await hydrateKeyRegistry(txnId);
}

/** Flush transaction record + signing key back to the durable store. */
async function persistDurableState(txnId) {
  if (!txnId) return;
  await persistToDurable(txnId);
  await persistKeyRegistry(txnId);
}

function normalizeCurrencyCode(code) {
  const raw = String(code ?? "840").trim();
  if (raw === "64") return "064";
  if (raw === "064") return "064";
  if (raw === "840" || raw === "356") return raw;
  throw new Error("Invalid currency. Allowed: 840, 356, 064");
}

function toMinorUnits(amountMajor, currencyNumeric) {
  const code = normalizeCurrencyCode(currencyNumeric);
  const currency = CURRENCY_CONFIG[code];
  const parsed = Number(amountMajor);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Invalid amount.");
  }
  return Math.round(parsed * 10 ** currency.minorDigits);
}

function analyzePurchaseIdFormat(purchaseId) {
  const value = String(purchaseId || "");
  const isNumeric = /^\d+$/.test(value);
  const hasExpectedLength = value.length === 19;
  const valid = PURCHASE_ID_REGEX.test(value);
  return {
    purchaseId: value,
    length: value.length,
    characterSet: isNumeric ? "NUMERIC" : "INVALID_CHARSET",
    expectedFormat: PURCHASE_ID_FORMAT_DESC,
    formatValidation: valid ? "PASS" : "FAIL",
    details: {
      hasExpectedLength,
      matchesRegex: valid
    }
  };
}

function generateTransactionId() {
  const maxAttempts = 5;
  for (let i = 0; i < maxAttempts; i += 1) {
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
    const suffix = String(crypto.randomInt(0, 100000)).padStart(5, "0");
    const txnId = `${stamp}${suffix}`;
    if (txnId.length !== 19) {
      continue;
    }
    if (!transactionExists(txnId)) {
      return txnId;
    }
  }
  throw new Error("Duplicate transaction ID generated. Retry.");
}

function stageTemplate() {
  return {
    created: "PASS",
    key: "PENDING",
    mkreqSent: "NOT RUN",
    mkreqResponse: "NOT RUN",
    mpireqCreated: "NOT RUN",
    mpiBuilt: "NOT RUN",
    macGenerated: "NOT RUN",
    hostedFormGenerated: "NOT RUN",
    hostedFormSubmitted: "NOT RUN",
    cardzoneResponseReceived: "NOT RUN",
    cardzoneCardFormPresent: "UNKNOWN",
    cardzoneRedirect: "NOT RUN",
    cardzonePageLoaded: "UNKNOWN",
    hostedSubmitted: "NOT RUN",
    callbackReceived: "NOT RUN",
    callbackMacVerified: "NOT RUN",
    inquiryRequest: "NOT RUN",
    inquiryResult: "NOT RUN",
    inquiry: "NOT RUN",
    final: "PENDING"
  };
}

function classifyInquiryOutcome(response) {
  const httpStatus = Number(response?.status || 0);
  const rawBody = response?.body;
  const body = typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody || {});

  const codeMatch = body.match(/MPI_ERROR_CODE\s*[=:]\s*['\"]?([A-Za-z0-9]+)['\"]?/i);
  const descMatch = body.match(/MPI_ERROR_DESC\s*[=:]\s*['\"]?([^'\"<\r\n]+)/i);
  const code = codeMatch ? codeMatch[1].toUpperCase() : "";
  const desc = descMatch ? descMatch[1].trim() : "";

  if (!httpStatus) {
    return { outcome: "TIMEOUT", code: "", description: "No HTTP status from inquiry." };
  }

  if (httpStatus >= 500) {
    return { outcome: "TIMEOUT", code, description: desc || `HTTP ${httpStatus}` };
  }

  if (httpStatus >= 400) {
    return { outcome: "FAILED", code: code || "HTTP_ERROR", description: desc || `HTTP ${httpStatus}` };
  }

  if (code === "000") {
    return { outcome: "SUCCESS", code, description: desc || "Approved by inquiry." };
  }

  if (code) {
    return { outcome: "FAILED", code, description: desc || "Inquiry returned failure code." };
  }

  if (/redirect failed|purchaseid|contact merchant/i.test(body)) {
    return {
      outcome: "NO_RESULT",
      code: "NO_RESULT",
      description: "Inquiry returned an HTML error page without result fields."
    };
  }

  return {
    outcome: "PROCESSING",
    code: "",
    description: "Inquiry completed but no final transaction result code was returned."
  };
}

function createTransaction(input) {
  const now = new Date();
  const txnId = generateTransactionId();
  const currency = normalizeCurrencyCode(input.currency || "840");
  const amountMajor = Number(input.amountMajor || 1.0).toFixed(2);
  const amountMinor = toMinorUnits(amountMajor, currency);
  const requestedMerchantId = String(input.merchantId || "").trim();
  const allowedMerchants = new Set(
    [config.MERCHANT_ID, ...config.UAT_ENROLLED_MERCHANT_IDS].filter(Boolean)
  );
  const effectiveMerchantId = requestedMerchantId || config.MERCHANT_ID;
  if (requestedMerchantId && !allowedMerchants.has(requestedMerchantId)) {
    throw new Error(
      `merchantId must be one of the enrolled UAT merchant IDs: ${[...allowedMerchants].join(", ")}`
    );
  }
  const callbackBaseUrl = String(config.CALLBACK_BASE_URL || "https://uatipg.vercel.app").replace(/\/+$/, "");
  const returnBaseUrl = String(input.returnBaseUrl || config.RETURN_BASE_URL || "https://uatipg.vercel.app").replace(/\/+$/, "");
  const cardzoneCallbackUrl = `${callbackBaseUrl}/api/callback`;
  const cardzoneBrowserReturnUrl = `${returnBaseUrl}/api/return?txnId=${txnId}`;
  const cardzoneMerchantResultUrl = cardzoneCallbackUrl;
  const cardzoneMpiResponseLink = cardzoneCallbackUrl;
  const cardzoneStatusUrl = cardzoneCallbackUrl;
  const responseUrl = cardzoneCallbackUrl;

  const txn = {
    txnId,
    orderRef: input.orderRef || txnId,
    merchantId: effectiveMerchantId,
    // MPI_PURCH_DATE is "the timestamp when merchant sends the transaction".
    // Cardzone (Bank of Bhutan) runs on Bhutan time (UTC+6), so send local
    // Thimphu time, not UTC. The MPI_MAC is signed over this exact value.
    mpiPurchaseDate: formatPurchaseDate(now),
    amountMinor,
    amountMajor,
    currency,
    currencyAlpha: CURRENCY_CONFIG[currency].alpha,
    responseUrl,
    merchantResultUrl: cardzoneMerchantResultUrl,
    mpiResponseLink: cardzoneMpiResponseLink,
    statusUrl: cardzoneStatusUrl,
    callbackUrl: cardzoneCallbackUrl,
    browserReturnUrl: cardzoneBrowserReturnUrl,
    environment: config.ENVIRONMENT,
    mode: config.MODE,
    createdAt: now.toISOString(),
    customer: {
      name: input.customerName || "",
      email: input.customerEmail || "",
      mobilePhone: input.mobilePhone || "",
      billingAddress: input.billingAddress || {},
      shippingAddress: input.shippingAddress || {}
    },
    status: "PENDING",
    mpiResult: "PENDING",
    callbackStatus: "WAITING",
    macStatus: "NOT RUN",
    finalResult: null,
    security: {
      keyMode: "UNSET",
      mkReqPubFingerprint: "",
      signingPubFingerprint: "",
      keyMatch: false,
      localMacVerification: "NOT RUN"
    },
    mkReq: {},
    mpiReq: {},
    outboundMercReq: {},
    callback: {},
    inquiry: {},
    diagnostics: {},
    timeline: stageTemplate(),
    timestamps: {
      createdAt: now.toISOString()
    }
  };

  saveTransaction(txn);

  logInfo("INIT", {
    transactionId: txn.txnId,
    merchantId: txn.merchantId,
    amountMajor: txn.amountMajor,
    currency: txn.currency
  });

  logInfo("TRANSACTION_ID", {
    transactionId: txn.txnId
  });

  logInfo("CARDZONE_MERCHANT_RESULT_URL", {
    transactionId: txn.txnId,
    merchantResultUrl: cardzoneMerchantResultUrl
  });

  logInfo("CARDZONE_MPI_RESPONSE_LINK", {
    transactionId: txn.txnId,
    mpiResponseLink: cardzoneMpiResponseLink
  });

  logInfo("CARDZONE_STATUS_URL", {
    transactionId: txn.txnId,
    statusUrl: cardzoneStatusUrl
  });

  logInfo("CARDZONE_CALLBACK_URL", {
    transactionId: txn.txnId,
    callbackUrl: cardzoneMerchantResultUrl
  });

  logInfo("CARDZONE_BROWSER_RETURN_URL", {
    transactionId: txn.txnId,
    browserReturnUrl: cardzoneBrowserReturnUrl
  });

  logInfo("CALLBACK_URL_SENT_TO_CARDZONE", {
    transactionId: txn.txnId,
    merchantId: txn.merchantId,
    callbackUrl: cardzoneMerchantResultUrl
  });

  return txn;
}

function loadOrGenerateKeys(txn) {
  const loadedPrivate = readPrivateKeyFromPath(config.MERCHANT_PRIVATE_KEY_PEM_PATH);
  let keyMode = "GENERATED_PER_TXN";
  let privateKeyPem;
  let publicKeyBase64Url;

  if (loadedPrivate) {
    keyMode = "CONFIGURED_PRIVATE_KEY";
    privateKeyPem = loadedPrivate;
    const derived = derivePublicKeyFromPrivatePem(loadedPrivate);
    publicKeyBase64Url = derived.publicKeyBase64Url;
  } else {
    const generated = generateRsa2048KeyPair();
    privateKeyPem = generated.privateKeyPem;
    publicKeyBase64Url = generated.publicKeyBase64Url;
  }

  if (!loadedPrivate) {
    persistGeneratedPrivateKey(txn.txnId, privateKeyPem);
  }

  keyRegistry.set(txn.txnId, {
    privateKeyPem,
    publicKeyBase64Url
  });

  txn.security.keyMode = keyMode;
  txn.security.mkReqPubFingerprint = fingerprintPublicKeyBase64Url(publicKeyBase64Url);
  txn.security.signingPubFingerprint = fingerprintPublicKeyBase64Url(publicKeyBase64Url);
  txn.security.keyMatch = txn.security.mkReqPubFingerprint === txn.security.signingPubFingerprint;
  txn.timeline.key = txn.security.keyMatch ? "PASS" : "FAIL";
  txn.timestamps.keyReadyAt = new Date().toISOString();

  saveTransaction(txn);
  return { privateKeyPem, publicKeyBase64Url };
}

function getOrLoadKeyData(txn) {
  const inMemory = keyRegistry.get(txn.txnId);
  if (inMemory?.privateKeyPem && inMemory?.publicKeyBase64Url) {
    return inMemory;
  }

  const configuredPrivate = readPrivateKeyFromPath(config.MERCHANT_PRIVATE_KEY_PEM_PATH);
  if (configuredPrivate) {
    const derived = derivePublicKeyFromPrivatePem(configuredPrivate);
    const loaded = {
      privateKeyPem: configuredPrivate,
      publicKeyBase64Url: derived.publicKeyBase64Url
    };
    keyRegistry.set(txn.txnId, loaded);
    return loaded;
  }

  const txnPrivate = loadTxnPrivateKey(txn.txnId);
  if (txnPrivate) {
    const derived = derivePublicKeyFromPrivatePem(txnPrivate);
    const loaded = {
      privateKeyPem: txnPrivate,
      publicKeyBase64Url: derived.publicKeyBase64Url
    };
    keyRegistry.set(txn.txnId, loaded);
    return loaded;
  }

  return null;
}

function extractCardzonePublicKey(mkReqResponse, fallbackPub) {
  return (
    mkReqResponse?.cardzonePubKey ||
    mkReqResponse?.cardzonePublicKey ||
    mkReqResponse?.pubKey ||
    mkReqResponse?.publicKey ||
    fallbackPub ||
    ""
  );
}

async function runMkReq(txnId) {
  await hydrateDurableState(txnId);
  const txn = loadTransaction(txnId);
  if (!txn) throw new Error("Transaction not found.");

  const keys = getOrLoadKeyData(txn) || loadOrGenerateKeys(txn);
  const purchaseIdValidation = analyzePurchaseIdFormat(txn.txnId);

  txn.mkReq.purchaseIdValidation = purchaseIdValidation;
  if (purchaseIdValidation.formatValidation !== "PASS") {
    txn.timeline.mkreqSent = "FAIL";
    txn.status = "FAILED";
    txn.finalResult = "PURCHASE_ID_FORMAT_INVALID";
    saveTransaction(txn);
    throw new Error(
      `purchaseId format invalid: ${purchaseIdValidation.purchaseId} (length=${purchaseIdValidation.length}, characterSet=${purchaseIdValidation.characterSet})`
    );
  }

  const payload = {
    merchantId: txn.merchantId,
    purchaseId: txn.txnId,
    pubKey: keys.publicKeyBase64Url
  };

  const mkReqPublicKeyFingerprint = fingerprintPublicKeyBase64Url(payload.pubKey);
  txn.security.mkReqPubFingerprint = mkReqPublicKeyFingerprint;

  if (config.ENABLE_MKREQ_MAC) {
    throw new Error("ENABLE_MKREQ_MAC=true is not supported without explicit Cardzone mkReq MAC specification details.");
  }

  txn.mkReq.request = payload;
  txn.timeline.mkreqSent = "PASS";
  txn.timestamps.mkReqSentAt = new Date().toISOString();

  if (config.MODE === "MOCK") {
    txn.mkReq.response = {
      errorCode: "000",
      merchantId: txn.merchantId,
      purchaseId: txn.txnId,
      cardzonePubKey: keys.publicKeyBase64Url
    };
    txn.mkReq.httpStatus = 200;
    txn.mkReq.elapsedMs = 5;
  } else {
    try {
      const mk = await doMkReq(payload);
      txn.mkReq.response = mk.data;
      txn.mkReq.httpStatus = mk.status;
      txn.mkReq.elapsedMs = mk.elapsedMs;
    } catch (error) {
      txn.mkReq.error = error.message;
      txn.timeline.mkreqResponse = "FAIL";
      txn.status = "FAILED";
      txn.finalResult = "MKREQ_FAILED";
      saveTransaction(txn);
      throw error;
    }
  }

  const errorCode = txn.mkReq.response?.errorCode || txn.mkReq.response?.ERROR_CODE;
  const success = errorCode === "000";
  txn.timeline.mkreqResponse = success ? "PASS" : "FAIL";
  if (!success) {
    txn.status = "FAILED";
    txn.finalResult = "MKREQ_REJECTED";
  }
  txn.mkReq.cardzonePublicKey = extractCardzonePublicKey(txn.mkReq.response, keys.publicKeyBase64Url);
  txn.timestamps.mkReqResponseAt = new Date().toISOString();
  saveTransaction(txn);
  await persistDurableState(txn.txnId);

  return txn;
}

function orderedDiagnosticFields(fieldsSafe) {
  const order = [
    "MPI_TRANS_TYPE",
    "MPI_MERC_ID",
    "MPI_PAN",
    "MPI_CARD_HOLDER_NAME",
    "MPI_PAN_EXP",
    "MPI_CVV2",
    "MPI_TRXN_ID",
    "MPI_ORI_TRXN_ID",
    "MPI_PURCH_DATE",
    "MPI_PURCH_CURR",
    "MPI_PURCH_AMT",
    "MPI_ADDR_MATCH",
    "MPI_BILL_ADDR_CITY",
    "MPI_BILL_ADDR_STATE",
    "MPI_BILL_ADDR_CNTRY",
    "MPI_BILL_ADDR_POSTCODE",
    "MPI_BILL_ADDR_LINE1",
    "MPI_BILL_ADDR_LINE2",
    "MPI_BILL_ADDR_LINE3",
    "MPI_SHIP_ADDR_CITY",
    "MPI_SHIP_ADDR_STATE",
    "MPI_SHIP_ADDR_CNTRY",
    "MPI_SHIP_ADDR_POSTCODE",
    "MPI_SHIP_ADDR_LINE1",
    "MPI_SHIP_ADDR_LINE2",
    "MPI_SHIP_ADDR_LINE3",
    "MPI_EMAIL",
    "MPI_HOME_PHONE",
    "MPI_HOME_PHONE_CC",
    "MPI_WORK_PHONE",
    "MPI_WORK_PHONE_CC",
    "MPI_MOBILE_PHONE",
    "MPI_MOBILE_PHONE_CC",
    "MPI_LINE_ITEM",
    "MPI_RESPONSE_TYPE",
    "MPI_RESPONSE_LINK"
  ];

  return order.map((name, idx) => ({
    idx: String(idx + 1).padStart(2, "0"),
    name,
    value: fieldsSafe[name] || ""
  }));
}

function buildInquiryPurchaseId(originalTxnId) {
  if (!String(originalTxnId || "").trim()) {
    throw new Error("Cannot build inquiry purchaseId: original transaction ID is missing.");
  }
  // Each inquiry needs its own unique transaction number; the original txn is
  // referenced separately via MPI_ORI_TRXN_ID.
  return generateTransactionId();
}

function buildMpiReq(txnId, cardInput) {
  const txn = loadTransaction(txnId);
  if (!txn) throw new Error("Transaction not found.");
  if (!txn.mkReq.response || (txn.mkReq.response.errorCode || txn.mkReq.response.ERROR_CODE) !== "000") {
    throw new Error("mkReq must succeed before MPIReq.");
  }

  const keyData = getOrLoadKeyData(txn);
  if (!keyData) {
    throw new Error("Signing key not found for transaction.");
  }

  const mkReqPublicKey = String(txn.mkReq?.request?.pubKey || "");
  if (!mkReqPublicKey) {
    throw new Error("mkReq public key is missing for transaction.");
  }
  const mkReqPublicKeyFingerprint = fingerprintPublicKeyBase64Url(mkReqPublicKey);

  const signingDerived = derivePublicKeyFromPrivatePem(keyData.privateKeyPem);
  const signingPrivateDerivedPublicKeyFingerprint = fingerprintPublicKeyBase64Url(
    signingDerived.publicKeyBase64Url
  );

  const keyPairMatch = mkReqPublicKeyFingerprint === signingPrivateDerivedPublicKeyFingerprint;

  logInfo("UAT_KEY_LIFECYCLE_CHECK", {
    transactionId: txn.txnId,
    MKREQ_PUBLIC_KEY_FINGERPRINT: mkReqPublicKeyFingerprint,
    SIGNING_PRIVATE_DERIVED_PUBLIC_KEY_FINGERPRINT: signingPrivateDerivedPublicKeyFingerprint,
    KEY_PAIR_MATCH: keyPairMatch
  });

  txn.security.mkReqPubFingerprint = mkReqPublicKeyFingerprint;
  txn.security.signingPubFingerprint = signingPrivateDerivedPublicKeyFingerprint;
  txn.security.keyMatch = keyPairMatch;

  if (!keyPairMatch) {
    txn.timeline.macGenerated = "FAIL";
    txn.status = "FAILED";
    txn.finalResult = "KEY_PAIR_MISMATCH";
    saveTransaction(txn);
    throw new Error("Aborted: mkReq public key fingerprint does not match signing private-key-derived public key fingerprint.");
  }

  const responseType = (cardInput.responseType || "STRING").toUpperCase();
  if (!/^\d{14}$/.test(String(txn.mpiPurchaseDate || ""))) {
    txn.mpiPurchaseDate = formatPurchaseDate();
  }
  const wirePurchaseDate = String(txn.mpiPurchaseDate);

  // This tool always uses the Hosted Payment Page: the cardholder types PAN,
  // name, expiry and CVV on Cardzone's own screen. The spec marks all four as
  // "Not Required for Hosted Payment Page", and Cardzone rebuilds the MPI_MAC
  // canonical string with these positions empty. Sending or signing any value
  // here produces a MAC mismatch (5A0), so they are forced blank.
  const suppliedCardData =
    String(cardInput.cardNumber || "") ||
    String(cardInput.cardHolderName || "") ||
    String(cardInput.expiry || "") ||
    String(cardInput.cvv || "");
  if (suppliedCardData) {
    logInfo("UAT_HOSTED_PAGE_CARD_DATA_IGNORED", {
      transactionId: txn.txnId,
      note: "PAN/holder name/expiry/CVV are collected on the Cardzone hosted page and are excluded from MPIReq and the MPI_MAC."
    });
  }

  const mpiFields = {
    MPI_TRANS_TYPE: "SALES",
    MPI_MERC_ID: txn.merchantId,
    MPI_PAN: "",
    MPI_CARD_HOLDER_NAME: "",
    MPI_PAN_EXP: "",
    MPI_CVV2: "",
    MPI_TRXN_ID: txn.txnId,
    MPI_ORI_TRXN_ID: cardInput.originalTxnId || "",
    MPI_PURCH_DATE: wirePurchaseDate,
    MPI_PURCH_CURR: txn.currency,
    MPI_PURCH_AMT: String(txn.amountMinor),
    MPI_ADDR_MATCH: cardInput.addrMatch || "",
    MPI_BILL_ADDR_CITY: txn.customer.billingAddress.city || "",
    MPI_BILL_ADDR_STATE: txn.customer.billingAddress.state || "",
    MPI_BILL_ADDR_CNTRY: txn.customer.billingAddress.country || "",
    MPI_BILL_ADDR_POSTCODE: txn.customer.billingAddress.postcode || "",
    MPI_BILL_ADDR_LINE1: txn.customer.billingAddress.line1 || "",
    MPI_BILL_ADDR_LINE2: txn.customer.billingAddress.line2 || "",
    MPI_BILL_ADDR_LINE3: txn.customer.billingAddress.line3 || "",
    MPI_SHIP_ADDR_CITY: txn.customer.shippingAddress.city || "",
    MPI_SHIP_ADDR_STATE: txn.customer.shippingAddress.state || "",
    MPI_SHIP_ADDR_CNTRY: txn.customer.shippingAddress.country || "",
    MPI_SHIP_ADDR_POSTCODE: txn.customer.shippingAddress.postcode || "",
    MPI_SHIP_ADDR_LINE1: txn.customer.shippingAddress.line1 || "",
    MPI_SHIP_ADDR_LINE2: txn.customer.shippingAddress.line2 || "",
    MPI_SHIP_ADDR_LINE3: txn.customer.shippingAddress.line3 || "",
    MPI_EMAIL: txn.customer.email || "",
    MPI_HOME_PHONE: cardInput.homePhone || "",
    MPI_HOME_PHONE_CC: cardInput.homePhoneCc || "",
    MPI_WORK_PHONE: cardInput.workPhone || "",
    MPI_WORK_PHONE_CC: cardInput.workPhoneCc || "",
    MPI_MOBILE_PHONE: txn.customer.mobilePhone || "",
    MPI_MOBILE_PHONE_CC: cardInput.mobilePhoneCc || "",
    MPI_LINE_ITEM: buildMpiLineItem(cardInput.lineItems || []),
    MPI_RESPONSE_LINK: txn.mpiResponseLink || txn.responseUrl,
    MPI_RESPONSE_TYPE: responseType
  };

  const mac = generateMpiMac(keyData.privateKeyPem, mpiFields, MAC_WIRE_PURCHASE_DATE_OPTIONS);
  mpiFields.MPI_MAC = mac.signature;

  const localVerify = verifySha256WithRsa(
    signingDerived.publicKeyBase64Url,
    mac.input,
    mac.signature
  );

  logInfo("UAT_LOCAL_MAC_VERIFY", {
    transactionId: txn.txnId,
    LOCAL_MAC_VERIFY: localVerify,
    MPI_MAC_LENGTH: mac.signature.length,
    MPI_MAC_SHA256: sha256Hex(mac.signature),
    MPI_MAC_CANONICAL_STRING_SHA256: mac.inputHash,
    DERIVED_PUBLIC_KEY_FINGERPRINT: signingPrivateDerivedPublicKeyFingerprint
  });

  const macCanonicalPurchaseDate = canonicalMpiPurchaseDateForCardzoneMac(
    wirePurchaseDate,
    MAC_WIRE_PURCHASE_DATE_OPTIONS
  );
  logInfo("UAT_MPI_MAC_DEBUG", {
    transactionId: txn.txnId,
    merchantId: txn.merchantId,
    wirePurchaseDate,
    macPurchaseDate: macCanonicalPurchaseDate,
    mpiMacCanonicalString: mac.input,
    mpiMacCanonicalStringLength: mac.input.length,
    mpiMacCanonicalStringSha256: mac.inputHash,
    publicKeyFingerprint: txn.security.mkReqPubFingerprint,
    signingKeyFingerprint: txn.security.signingPubFingerprint,
    keyPairMatch: txn.security.keyMatch
  });

  const verifyResult = localVerify;

  runtimeMpiRegistry.set(txnId, { ...mpiFields });
  // Also persist the exact wire fields on the transaction record so the hosted
  // form can be rebuilt on a different serverless invocation. For the Hosted
  // Payment Page these fields carry no card data (PAN/name/expiry/CVV are
  // blank); MPI_MAC is transmitted to Cardzone in the browser form anyway.
  txn.mpiReqRuntimeFields = { ...mpiFields };

  const safeFields = {
    ...mpiFields,
    MPI_PAN: maskPan(mpiFields.MPI_PAN),
    MPI_CVV2: "***"
  };

  txn.security.localMacVerification = verifyResult ? "PASS" : "FAIL";
  txn.mpiReq = {
    fieldsSafe: safeFields,
    orderedFields: orderedDiagnosticFields(safeFields),
    wirePurchaseDate,
    macPurchaseDate: macCanonicalPurchaseDate,
    signInputLength: mac.input.length,
    signInputHash: mac.inputHash,
    mpiMac: mac.signature,
    mpiMacLength: mac.signature.length,
    signedValueHash: sha256Hex(canonicalMpiMacInput(mpiFields, MAC_WIRE_PURCHASE_DATE_OPTIONS)),
    submittedValueHash: sha256Hex(canonicalMpiMacInput(mpiFields, MAC_WIRE_PURCHASE_DATE_OPTIONS))
  };

  txn.diagnostics.localMacProof = {
    localMacVerify: localVerify,
    mpiMacLength: mac.signature.length,
    mpiMacSha256: sha256Hex(mac.signature),
    mpiMacCanonicalStringSha256: mac.inputHash,
    derivedPublicKeyFingerprint: signingPrivateDerivedPublicKeyFingerprint
  };

  txn.timeline.mpiBuilt = "PASS";
  txn.timeline.mpireqCreated = "PASS";
  txn.timeline.macGenerated = verifyResult ? "PASS" : "FAIL";
  txn.macStatus = verifyResult ? "LOCAL_PASS" : "LOCAL_FAIL";
  txn.timestamps.mpiBuiltAt = new Date().toISOString();

  saveTransaction(txn);
  return txn;
}

function generateHostedFormHtml(txnId) {
  const txn = loadTransaction(txnId);
  if (!txn) throw new Error("Transaction not found.");
  // Prefer the in-memory copy; fall back to the copy persisted on the
  // transaction record (survives a cold serverless invocation / KV rehydrate).
  const runtimeFields = runtimeMpiRegistry.get(txnId) || txn.mpiReqRuntimeFields;
  if (!runtimeFields) {
    throw new Error("MPIReq runtime fields unavailable. Rebuild MPIReq for hosted submission.");
  }
  runtimeMpiRegistry.set(txnId, { ...runtimeFields });

  const finalHtmlPurchaseDate = String(runtimeFields.MPI_PURCH_DATE || "");
  const finalHtmlPurchaseId = String(runtimeFields.MPI_TRXN_ID || "");
  const finalHtmlMerchantId = String(runtimeFields.MPI_MERC_ID || "");
  const finalHtmlMac = String(runtimeFields.MPI_MAC || "");
  const finalHtmlMacSha256 = sha256Hex(finalHtmlMac);
  const storedWirePurchaseDate = String(txn.mpiPurchaseDate || "");
  const finalHtmlEqualsStoredWire = finalHtmlPurchaseDate === storedWirePurchaseDate;

  if (!finalHtmlEqualsStoredWire) {
    txn.timeline.hostedFormGenerated = "FAIL";
    txn.status = "FAILED";
    txn.finalResult = "MPI_PURCH_DATE_MISMATCH_BEFORE_SUBMIT";
    saveTransaction(txn);
    throw new Error("Aborted: hosted form MPI_PURCH_DATE does not match stored transaction wire purchase date.");
  }

  const inputs = Object.entries(runtimeFields)
    .map(([k, v]) => `<input type=\"hidden\" name=\"${escapeHtml(k)}\" value=\"${escapeHtml(v)}\" />`)
    .join("\n");

  txn.outboundMercReq = {
    endpoint: config.CARDZONE_MERC_REQ_URL,
    method: "POST_FORM",
    fieldNames: Object.keys(runtimeFields),
    fieldValuesSafe: {
      ...runtimeFields,
      MPI_PAN: maskPan(runtimeFields.MPI_PAN),
      MPI_CVV2: "***"
    },
    mpiMac: runtimeFields.MPI_MAC,
    macInputHash: txn.mpiReq.signInputHash,
    keyFingerprint: txn.security.mkReqPubFingerprint,
    signedValueHash: txn.mpiReq.signedValueHash,
    submittedValueHash: sha256Hex(canonicalMpiMacInput(runtimeFields, MAC_WIRE_PURCHASE_DATE_OPTIONS)),
    formSubmissionCheck:
      txn.mpiReq.signedValueHash ===
      sha256Hex(canonicalMpiMacInput(runtimeFields, MAC_WIRE_PURCHASE_DATE_OPTIONS))
        ? "MATCH"
        : "MISMATCH"
  };

  const formMacValue = finalHtmlMac;
  const generatedMacValue = String(txn.mpiReq.mpiMac || "");
  const formMacEqualsGeneratedMac = formMacValue === generatedMacValue;
  const formMacSha256 = sha256Hex(formMacValue);
  const generatedMacSha256 = sha256Hex(generatedMacValue);
  const hostedFormPurchaseDate = String(runtimeFields.MPI_PURCH_DATE || "");
  const formPurchaseDateEqualsStoredWireDate =
    hostedFormPurchaseDate === storedWirePurchaseDate;
  const macCanonicalPurchaseDate = canonicalMpiPurchaseDateForCardzoneMac(
    storedWirePurchaseDate,
    MAC_WIRE_PURCHASE_DATE_OPTIONS
  );
  const mpiMacCanonicalString = canonicalMpiMacInput(
    runtimeFields,
    MAC_WIRE_PURCHASE_DATE_OPTIONS
  );

  logInfo("UAT_FINAL_HTML_FORM_VALUES", {
    transactionId: txn.txnId,
    FINAL_HTML_MPI_PURCH_DATE: finalHtmlPurchaseDate,
    FINAL_HTML_MPI_PURCH_DATE_URLENCODED: encodeURIComponent(finalHtmlPurchaseDate),
    FINAL_HTML_MPI_MAC_SHA256: finalHtmlMacSha256,
    FINAL_HTML_PURCHASE_ID: finalHtmlPurchaseId,
    FINAL_HTML_MERCHANT_ID: finalHtmlMerchantId,
    FINAL_HTML_PURCHASE_DATE_EQUALS_STORED_WIRE_DATE: finalHtmlEqualsStoredWire
  });

  logInfo("UAT_FORM_MAC_CHECK", {
    transactionId: txn.txnId,
    STORED_WIRE_MPI_PURCH_DATE: storedWirePurchaseDate,
    HOSTED_FORM_PURCHASE_DATE: hostedFormPurchaseDate,
    HOSTED_FORM_PURCHASE_DATE_SHA256: sha256Hex(hostedFormPurchaseDate),
    MPI_MAC_CANONICAL_PURCHASE_DATE: macCanonicalPurchaseDate,
    MPI_MAC_CANONICAL_STRING: mpiMacCanonicalString,
    MPI_MAC_CANONICAL_STRING_SHA256: sha256Hex(mpiMacCanonicalString),
    FORM_MPI_MAC_EQUALS_GENERATED_MAC: formMacEqualsGeneratedMac,
    FORM_PURCHASE_DATE_EQUALS_STORED_WIRE_DATE: formPurchaseDateEqualsStoredWireDate,
    FORM_MPI_MAC_SHA256: formMacSha256,
    MPI_MAC_SHA256: generatedMacSha256
  });

  txn.diagnostics.formMacProof = {
    storedWireMpiPurchDate: storedWirePurchaseDate,
    hostedFormPurchaseDate,
    hostedFormPurchaseDateSha256: sha256Hex(hostedFormPurchaseDate),
    mpiMacCanonicalPurchaseDate: macCanonicalPurchaseDate,
    mpiMacCanonicalString,
    mpiMacCanonicalStringSha256: sha256Hex(mpiMacCanonicalString),
    formMpiMacEqualsGeneratedMac: formMacEqualsGeneratedMac,
    formPurchaseDateEqualsStoredWireDate,
    formMpiMacSha256: formMacSha256,
    mpiMacSha256: generatedMacSha256
  };

  txn.timeline.hostedFormGenerated = "PASS";
  txn.timestamps.hostedFormGeneratedAt = new Date().toISOString();
  saveTransaction(txn);

  logInfo("HOSTED_FORM_GENERATED", {
    transactionId: txn.txnId
  });
  logInfo("CARDZONE_CALLBACK_URL", {
    transactionId: txn.txnId,
    callbackUrl: txn.callbackUrl || `${String(config.CALLBACK_BASE_URL).replace(/\/+$/, "")}/api/callback`
  });
  logInfo("CARDZONE_BROWSER_RETURN_URL", {
    transactionId: txn.txnId,
    browserReturnUrl: txn.browserReturnUrl || `${String(config.RETURN_BASE_URL).replace(/\/+$/, "")}/api/return?txnId=${txn.txnId}`
  });

    // The Cardzone spec (rev 2.3) asks for an iframe, but the UAT mercReq
    // response is served with `X-Frame-Options: DENY`, so the hosted card /
    // 3DS pages cannot be embedded - they must load as a top-level navigation.
    // The form auto-submits (see /autopost.js) straight to Cardzone; the
    // browser returns to MPI_RESPONSE_LINK and the server callback is the
    // authoritative result.
    return `<!doctype html>
  <html>
  <head>
    <meta charset=\"utf-8\" />
    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
    <title>Cardzone UAT Hosted Payment</title>
  </head>
  <body>
    <p>Redirecting to the Cardzone secure payment page. Do not refresh or close this window.</p>
    <form id=\"mercReqForm\" method=\"POST\" action=\"${escapeHtml(config.CARDZONE_MERC_REQ_URL)}\">${inputs}</form>
    <script src=\"/autopost.js\"></script>
    <noscript><button type=\"submit\" form=\"mercReqForm\">Continue to Cardzone</button></noscript>
  </body>
  </html>`;
}

function escapeHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function processCallback(formData, metadata = {}) {
  const rawTxnId = String(
    formData.MPI_TRXN_ID ||
    formData.mpi_trxn_id ||
    formData.MPI_TXN_ID ||
    formData.mpi_txn_id ||
    formData.txnId ||
    formData.transactionId ||
    formData.purchaseId ||
    formData.MPI_PURCHASE_ID ||
    metadata.txnId ||
    ""
  ).trim();

  let txn = rawTxnId ? loadTransaction(rawTxnId) : null;
  if (!txn) {
    // Never attach a callback to an unrelated "most recent" transaction: on a
    // shared or serverless instance that mis-binds concurrent payments. Build a
    // recovery record keyed by the transaction ID Cardzone actually sent.
    {
      const recoveryId = rawTxnId || generateTransactionId();
      const now = new Date();
      txn = {
        txnId: recoveryId,
        orderRef: recoveryId,
        merchantId: String(formData.MPI_MERC_ID || config.MERCHANT_ID || "").trim() || config.MERCHANT_ID,
        mpiPurchaseDate: formatPurchaseDate(now),
        amountMinor: 100,
        amountMajor: "1.00",
        currency: "840",
        currencyAlpha: "USD",
        responseUrl: `${String(config.CALLBACK_BASE_URL || "https://uatipg.vercel.app").replace(/\/+$/, "")}/api/callback`,
        callbackUrl: `${String(config.CALLBACK_BASE_URL || "https://uatipg.vercel.app").replace(/\/+$/, "")}/api/callback`,
        browserReturnUrl: `${String(config.RETURN_BASE_URL || "https://uatipg.vercel.app").replace(/\/+$/, "")}/api/return?txnId=${recoveryId}`,
        environment: config.ENVIRONMENT,
        mode: config.MODE,
        createdAt: now.toISOString(),
        status: "PROCESSING",
        stage: "callback",
        timeline: stageTemplate(),
        timestamps: {
          createdAt: now.toISOString(),
          recoveredAt: now.toISOString()
        },
        security: {
          keyMode: "RECOVERED",
          keyMatch: true
        },
        cardzone: {},
        mkReq: {
          cardzonePublicKey: config.CARDZONE_PUBLIC_KEY
        },
        mpiReq: {},
        callback: {},
        inquiry: {},
        returnState: {},
        finalResult: {
          source: "callback",
          status: "PROCESSING"
        }
      };
      saveTransaction(txn);
      logInfo("CALLBACK_TRANSACTION_RECOVERED", {
        transactionId: txn.txnId,
        merchantId: txn.merchantId,
        note: "Initialized recovered transaction state from incoming callback"
      });
    }
  }

  const txnId = txn.txnId;

  const callbackFields = {
    MPI_MERC_ID: String(formData.MPI_MERC_ID || txn.merchantId || "").trim(),
    MPI_TRXN_ID: String(formData.MPI_TRXN_ID || txnId).trim(),
    MPI_MAC: String(formData.MPI_MAC || "").trim(),
    MPI_ERROR_CODE: String(formData.MPI_ERROR_CODE || "").trim(),
    MPI_ERROR_DESC: String(formData.MPI_ERROR_DESC || "").trim(),
    MPI_APPR_CODE: String(formData.MPI_APPR_CODE || "").trim(),
    MPI_RRN: String(formData.MPI_RRN || "").trim(),
    MPI_BIN: String(formData.MPI_BIN || "").trim(),
    MPI_REFERRAL_CODE: String(formData.MPI_REFERRAL_CODE || "").trim(),
    MPI_CARDHOLDER_INFO: String(formData.MPI_CARDHOLDER_INFO || "").trim()
  };

  logInfo("MERCHANT_RESULT_MPI_TRXN_ID", { transactionId: txnId });
  logInfo("CALLBACK_MPI_TRXN_ID", { transactionId: txnId });

  logInfo("MERCHANT_RESULT_MPI_ERROR_CODE", {
    transactionId: txnId,
    errorCode: callbackFields.MPI_ERROR_CODE,
    errorDesc: callbackFields.MPI_ERROR_DESC
  });
  logInfo("CALLBACK_MPI_ERROR_CODE", {
    transactionId: txnId,
    errorCode: callbackFields.MPI_ERROR_CODE,
    errorDesc: callbackFields.MPI_ERROR_DESC
  });

  logInfo("MERCHANT_RESULT_MPI_MAC_PRESENT", {
    transactionId: txnId,
    macPresent: Boolean(callbackFields.MPI_MAC),
    macLength: callbackFields.MPI_MAC ? callbackFields.MPI_MAC.length : 0
  });
  logInfo("CALLBACK_MPI_MAC_PRESENT", {
    transactionId: txnId,
    macPresent: Boolean(callbackFields.MPI_MAC),
    macLength: callbackFields.MPI_MAC ? callbackFields.MPI_MAC.length : 0
  });

  txn.callback.receivedAt = new Date().toISOString();
  txn.timestamps.callbackReceivedAt = txn.callback.receivedAt;
  txn.callback.fields = callbackFields;
  txn.callback.httpStatus = 200;
  txn.callback.contentType = metadata.contentType || "";
  txn.callback.source = metadata.source || "unknown";
  txn.callbackStatus = "RECEIVED";
  txn.timeline.callbackReceived = "PASS";
  txn.callbackReceived = true;

  const cardzonePub =
    txn.mkReq?.cardzonePublicKey ||
    config.CARDZONE_PUBLIC_KEY ||
    txn.mkReq?.request?.pubKey ||
    "";
  if (!cardzonePub) {
    logInfo("CALLBACK_MAC_KEY_UNAVAILABLE", {
      transactionId: txnId,
      note: "No Cardzone public key available (mkReq record lost and CARDZONE_PUBLIC_KEY not set); callback MAC cannot be verified."
    });
  }
  const verified = verifyCallbackMac(cardzonePub, callbackFields, callbackFields.MPI_MAC);
  txn.callback.macVerified = verified.ok;
  txn.callbackMacVerified = verified.ok;
  txn.callback.macInputHash = verified.inputHash;
  txn.callback.macInputLength = verified.input.length;
  txn.timestamps.callbackMacVerifiedAt = new Date().toISOString();
  txn.timeline.callbackMacVerified = verified.ok ? "PASS" : "FAIL";

  logInfo("MERCHANT_RESULT_MPI_MAC_VERIFIED", {
    transactionId: txnId,
    macVerified: verified.ok,
    macInputHash: verified.inputHash
  });
  logInfo("CALLBACK_MAC_VERIFIED", {
    transactionId: txnId,
    macVerified: verified.ok,
    macInputHash: verified.inputHash
  });

  const responseCode = callbackFields.MPI_ERROR_CODE;
  const responseDescription = callbackFields.MPI_ERROR_DESC;
  const approvalCode = callbackFields.MPI_APPR_CODE;
  const rrn = callbackFields.MPI_RRN;
  const bin = callbackFields.MPI_BIN;
  const referralCode = callbackFields.MPI_REFERRAL_CODE;
  const cardholderInfo = callbackFields.MPI_CARDHOLDER_INFO;

  txn.responseCode = responseCode;
  txn.responseDescription = responseDescription;
  txn.approvalCode = approvalCode;
  txn.RRN = rrn;
  txn.BIN = bin;
  txn.referralCode = referralCode;
  txn.cardholderInfo = cardholderInfo;

  txn.callback.callbackReceived = true;
  txn.callback.callbackMacVerified = verified.ok;
  txn.callback.responseCode = responseCode;
  txn.callback.responseDescription = responseDescription;
  txn.callback.approvalCode = approvalCode;
  txn.callback.RRN = rrn;
  txn.callback.BIN = bin;
  txn.callback.referralCode = referralCode;
  txn.callback.cardholderInfo = cardholderInfo;

  const resolvedAt = new Date().toISOString();

  if (responseCode === "5A0") {
    txn.status = "FAILED";
    txn.mpiResult = "5A0";
    txn.timeline.final = "FAIL";
    txn.diagnostics.cardzone5A0 = {
      title: "MAC verification failed at Cardzone.",
      explanation: "The merchant generated a locally valid signature, but Cardzone did not accept it.",
      transactionId: txn.txnId,
      merchantId: txn.merchantId,
      mkReqStatus: txn.timeline.mkreqResponse,
      publicKeyFingerprint: txn.security.mkReqPubFingerprint,
      macInputSha256: txn.mpiReq?.signInputHash,
      macInputLength: txn.mpiReq?.signInputLength,
      mpiMacLength: txn.mpiReq?.mpiMacLength,
      keyPairMatch: txn.security.keyMatch,
      formSubmissionCheck: txn.outboundMercReq?.formSubmissionCheck
    };
    txn.finalResult = {
      source: "callback",
      status: "FAILED",
      responseCode: "5A0",
      responseDescription: responseDescription || "MAC verification failed at Cardzone",
      approvalCode,
      rrn,
      bin,
      referralCode,
      cardholderInfo,
      resolvedAt
    };
    txn.timestamps.finalAt = resolvedAt;
  } else if (verified.ok) {
    if (responseCode === "000" && Boolean(approvalCode)) {
      txn.status = "SUCCESS";
      txn.mpiResult = "SUCCESS";
      txn.timeline.final = "PASS";
    } else if (responseCode === "000") {
      txn.status = "SUCCESS";
      txn.mpiResult = "SUCCESS";
      txn.timeline.final = "PASS";
    } else {
      txn.status = "FAILED";
      txn.mpiResult = responseCode || "UNKNOWN";
      txn.timeline.final = "FAIL";
    }

    txn.finalResult = {
      source: "callback",
      status: txn.status,
      responseCode,
      responseDescription,
      approvalCode,
      rrn,
      bin,
      referralCode,
      cardholderInfo,
      resolvedAt
    };
    txn.timestamps.finalAt = resolvedAt;
  } else {
    txn.status = "FAILED";
    txn.mpiResult = "CALLBACK_MAC_INVALID";
    txn.timeline.final = "FAIL";
    txn.finalResult = {
      source: "callback",
      status: "FAILED",
      responseCode,
      responseDescription,
      approvalCode,
      rrn,
      bin,
      referralCode,
      cardholderInfo,
      error: "CALLBACK_MAC_INVALID",
      resolvedAt
    };
    txn.timestamps.finalAt = resolvedAt;
  }

  logInfo("MERCHANT_RESULT_SAVED", {
    transactionId: txnId,
    status: txn.status,
    source: "merchant_url",
    macVerified: verified.ok,
    saved: true
  });

  logInfo("CALLBACK_RESULT_SAVED", {
    transactionId: txnId,
    status: txn.status,
    source: "callback",
    macVerified: verified.ok,
    saved: true
  });

  saveTransaction(txn);
  return txn;
}

async function runInquiry(txnId) {
  await hydrateDurableState(txnId);
  const txn = loadTransaction(txnId);
  if (!txn) throw new Error("Transaction not found.");

  const keyData = getOrLoadKeyData(txn);
  if (!keyData) {
    throw new Error("Cannot run inquiry: signing key is missing in runtime.");
  }

  logInfo("INQUIRY_STARTED", { transactionId: txnId });

  const inquiryPurchaseId = buildInquiryPurchaseId(txnId);
  const reqFields = {
    MPI_TRANS_TYPE: "INQ",
    MPI_MERC_ID: txn.merchantId,
    MPI_PAN: "",
    MPI_CARD_HOLDER_NAME: "",
    MPI_PAN_EXP: "",
    MPI_CVV2: "",
    MPI_TRXN_ID: inquiryPurchaseId,
    MPI_ORI_TRXN_ID: txn.txnId,
    MPI_PURCH_DATE: formatPurchaseDate(),
    MPI_PURCH_CURR: "",
    MPI_PURCH_AMT: "",
    MPI_ADDR_MATCH: "",
    MPI_BILL_ADDR_CITY: "",
    MPI_BILL_ADDR_STATE: "",
    MPI_BILL_ADDR_CNTRY: "",
    MPI_BILL_ADDR_POSTCODE: "",
    MPI_BILL_ADDR_LINE1: "",
    MPI_BILL_ADDR_LINE2: "",
    MPI_BILL_ADDR_LINE3: "",
    MPI_SHIP_ADDR_CITY: "",
    MPI_SHIP_ADDR_STATE: "",
    MPI_SHIP_ADDR_CNTRY: "",
    MPI_SHIP_ADDR_POSTCODE: "",
    MPI_SHIP_ADDR_LINE1: "",
    MPI_SHIP_ADDR_LINE2: "",
    MPI_SHIP_ADDR_LINE3: "",
    MPI_EMAIL: "",
    MPI_HOME_PHONE: "",
    MPI_HOME_PHONE_CC: "",
    MPI_WORK_PHONE: "",
    MPI_WORK_PHONE_CC: "",
    MPI_MOBILE_PHONE: "",
    MPI_MOBILE_PHONE_CC: "",
    MPI_LINE_ITEM: "",
    MPI_RESPONSE_TYPE: "STRING"
  };

  logInfo("INQUIRY_ORIGINAL_TRANSACTION_ID", {
    transactionId: txnId,
    originalTxnId: txn.txnId,
    inquiryTxnId: inquiryPurchaseId
  });

  const mac = generateMpiMac(keyData.privateKeyPem, reqFields, MAC_WIRE_PURCHASE_DATE_OPTIONS);
  reqFields.MPI_MAC = mac.signature;

  txn.inquiry.request = {
    ...reqFields,
    MPI_CVV2: "***"
  };

  if (config.MODE === "MOCK") {
    txn.inquiry.response = {
      status: 200,
      MPI_TRXN_ID: txnId,
      MPI_ERROR_CODE: txn.callback.fields?.MPI_ERROR_CODE || "000",
      MPI_ERROR_DESC: "Mock inquiry response"
    };
    txn.inquiry.macVerified = true;
    txn.timeline.inquiryRequest = "PASS";
    txn.inquiry.result = {
      outcome: txn.inquiry.response.MPI_ERROR_CODE === "000" ? "SUCCESS" : "FAILED",
      code: txn.inquiry.response.MPI_ERROR_CODE,
      description: txn.inquiry.response.MPI_ERROR_DESC
    };
  } else {
    const result = await doFormPost(config.CARDZONE_INQUIRY_URL, reqFields);
    txn.inquiry.response = {
      status: result.status,
      elapsedMs: result.elapsedMs,
      body: result.data
    };
    txn.inquiry.macVerified = null;
    txn.timeline.inquiryRequest = result.status >= 200 && result.status < 300 ? "PASS" : "FAIL";
    txn.inquiry.result = classifyInquiryOutcome(txn.inquiry.response);
  }

  logInfo("INQUIRY_RESULT_CODE", {
    transactionId: txnId,
    outcome: txn.inquiry.result?.outcome,
    code: txn.inquiry.result?.code
  });

  logInfo("INQUIRY_MAC_VERIFIED", {
    transactionId: txnId,
    inquiryMacVerified: Boolean(txn.inquiry.macVerified)
  });

  txn.timeline.inquiryResult = txn.inquiry.result?.outcome || "NOT RUN";
  txn.timeline.inquiry = "PASS";
  txn.timestamps.inquiryAt = new Date().toISOString();

  // Priority 1 is verified callback. If callback MAC is not verified, apply inquiry result (Priority 2)
  if (!txn.callback?.macVerified && !txn.callbackMacVerified) {
    const outcome = txn.inquiry.result?.outcome;
    const resolvedAt = new Date().toISOString();
    if (outcome === "SUCCESS") {
      txn.status = "SUCCESS";
      txn.mpiResult = "SUCCESS";
      txn.timeline.final = "PASS";
      txn.finalResult = {
        source: "inquiry",
        status: "SUCCESS",
        responseCode: txn.inquiry.result?.code || "000",
        responseDescription: txn.inquiry.result?.description || "Inquiry Approved",
        resolvedAt
      };
      txn.timestamps.finalAt = resolvedAt;
    } else if (outcome === "FAILED") {
      txn.status = "FAILED";
      txn.mpiResult = txn.inquiry.result?.code || "UNKNOWN";
      txn.timeline.final = "FAIL";
      txn.finalResult = {
        source: "inquiry",
        status: "FAILED",
        responseCode: txn.inquiry.result?.code || "UNKNOWN",
        responseDescription: txn.inquiry.result?.description || "Inquiry Failed",
        resolvedAt
      };
      txn.timestamps.finalAt = resolvedAt;
    } else {
      txn.status = "PENDING";
      txn.mpiResult = "PENDING";
      txn.timeline.final = "PENDING";
      txn.finalResult = {
        source: "inquiry",
        status: "PENDING",
        responseCode: txn.inquiry.result?.code || "",
        responseDescription: txn.inquiry.result?.description || "Inquiry Pending",
        resolvedAt
      };
    }
  }

  saveTransaction(txn);
  await persistDurableState(txn.txnId);
  return txn;
}

function getTxDetail(txnId) {
  return loadTransaction(txnId);
}

function getDashboard(filter = "ALL") {
  let txns = listRecentTransactions(100);
  if (filter === "SUCCESS") txns = txns.filter((t) => t.status === "SUCCESS");
  if (filter === "FAILED") txns = txns.filter((t) => t.status === "FAILED");
  if (filter === "PENDING") txns = txns.filter((t) => t.status === "PENDING");
  if (filter === "5A0") txns = txns.filter((t) => t.mpiResult === "5A0");
  if (filter === "INQUIRY") txns = txns.filter((t) => t.timeline.inquiry === "PASS");

  return txns.map((t) => ({
    txnId: t.txnId,
    createdAt: t.createdAt,
    amountMajor: t.amountMajor,
    currency: t.currency,
    status: t.status,
    mpiResult: t.mpiResult,
    callback: t.callbackStatus,
    macStatus: t.macStatus
  }));
}

function getConfigView() {
  return {
    appVersion: config.APP_VERSION,
    environment: config.ENVIRONMENT,
    mode: config.MODE,
    bindHost: config.BIND_HOST,
    merchantId: config.MERCHANT_ID,
    enrolledMerchantIds: config.UAT_ENROLLED_MERCHANT_IDS,
    cardzonePublicKeyConfigured: Boolean(config.CARDZONE_PUBLIC_KEY),
    durableStateStore: durableEnabled() ? "kv-rest" : "ephemeral-tmp",
    callbackBaseUrl: config.CALLBACK_BASE_URL,
    returnBaseUrl: config.RETURN_BASE_URL,
    callbackEndpoint: `${config.CALLBACK_BASE_URL}/api/callback`,
    returnEndpoint: `${config.RETURN_BASE_URL}/api/return`,
    endpoints: {
      mkReq: config.CARDZONE_MKREQ_URL,
      mercReq: config.CARDZONE_MERC_REQ_URL,
      inquiry: config.CARDZONE_INQUIRY_URL
    },
    enableMkReqMac: config.ENABLE_MKREQ_MAC,
    mpiMacIncludeResponseType: config.MPI_MAC_INCLUDE_RESPONSE_TYPE,
    mpiMacPurchaseDateTimezone: config.MPI_MAC_PURCHASE_DATE_TIMEZONE,
    useProxy: config.USE_CARDZONE_PROXY,
    proxy: {
      host: config.CARDZONE_PROXY_HOST,
      port: config.CARDZONE_PROXY_PORT,
      httpProxyEnv: config.HTTP_PROXY,
      httpsProxyEnv: config.HTTPS_PROXY
    },
    emv3ds: UAT_3DSS_CONFIG,
    currencies: CURRENCY_CONFIG
  };
}

function exportSafeDiagnostic(txnId) {
  const txn = loadTransaction(txnId);
  if (!txn) throw new Error("Transaction not found.");

  return {
    environment: txn.environment,
    merchantId: txn.merchantId,
    transactionId: txn.txnId,
    mkReqStatus: txn.timeline.mkreqResponse,
    mkReqEndpoint: config.CARDZONE_MKREQ_URL,
    merchantPublicKeyFingerprint: txn.security.mkReqPubFingerprint,
    keyPairMatch: txn.security.keyMatch,
    mpiSigningInputSha256: txn.mpiReq.signInputHash,
    mpiSigningInputLength: txn.mpiReq.signInputLength,
    mpiMacLength: txn.mpiReq.mpiMacLength,
    mpiMac: txn.mpiReq.mpiMac,
    mpiReqEndpoint: config.CARDZONE_MERC_REQ_URL,
    httpMethod: "POST_FORM",
    callbackReceived: txn.timeline.callbackReceived,
    callbackMacVerified: txn.callback.macVerified,
    cardzoneResponseCode: txn.callback.fields?.MPI_ERROR_CODE || "",
    cardzoneResponseDescription: txn.callback.fields?.MPI_ERROR_DESC || "",
    inquiryStatus: txn.timeline.inquiry,
    maskedFields: {
      pan: txn.mpiReq.fieldsSafe?.MPI_PAN || "",
      cvv: "***",
      privateKey: "[REDACTED_PRIVATE_KEY]"
    }
  };
}

function saveUatPrivateKeyIfGenerated(txnId) {
  const keyData = keyRegistry.get(txnId);
  if (!keyData) return null;

  const file = persistGeneratedPrivateKey(txnId, keyData.privateKeyPem);
  return file;
}

module.exports = {
  generateTransactionId,
  analyzePurchaseIdFormat,
  createTransaction,
  runMkReq,
  buildMpiReq,
  generateHostedFormHtml,
  processCallback,
  runInquiry,
  getTxDetail,
  getDashboard,
  getConfigView,
  exportSafeDiagnostic,
  toMinorUnits,
  saveUatPrivateKeyIfGenerated,
  loadTxnPrivateKey,
  getOrLoadKeyData,
  hydrateDurableState,
  persistDurableState,
  CURRENCY_CONFIG
};
