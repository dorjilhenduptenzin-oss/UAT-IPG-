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
  formatUtcPurchaseDate,
  formatPurchaseDate,
  canonicalMpiPurchaseDateForCardzoneMac,
  buildMpiLineItem,
  generateMpiMac,
  verifyCallbackMac,
  canonicalMpiMacInput
} = require("../cardzone/mpi");
const { sha256Hex } = require("../utils/hash");
const { maskPan } = require("../utils/mask");
const { config } = require("../config/env");
const { UAT_3DSS_CONFIG } = require("../config/uat3dss");
const {
  saveTransaction,
  loadTransaction,
  transactionExists,
  listRecentTransactions
} = require("../storage/transactions");

const keyRegistry = new Map();
const runtimeMpiRegistry = new Map();

const CURRENCY_CONFIG = Object.freeze({
  "840": { alpha: "USD", minorDigits: 2 },
  "356": { alpha: "INR", minorDigits: 2 },
  "064": { alpha: "BTN", minorDigits: 2 }
});

const PURCHASE_ID_REGEX = /^\d{19}$/;
const PURCHASE_ID_FORMAT_DESC = "YYYYMMDDHHmmss + 5 numeric digits (19 chars total)";

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
  const txnId = generateTransactionId();
  const currency = normalizeCurrencyCode(input.currency || "840");
  const amountMajor = Number(input.amountMajor || 1.0).toFixed(2);
  const amountMinor = toMinorUnits(amountMajor, currency);

  const txn = {
    txnId,
    orderRef: input.orderRef || txnId,
    merchantId: input.merchantId || config.MERCHANT_ID,
    amountMinor,
    amountMajor,
    currency,
    currencyAlpha: CURRENCY_CONFIG[currency].alpha,
    responseUrl: input.responseUrl || `${config.RETURN_BASE_URL}/api/return?txnId=${txnId}`,
    environment: config.ENVIRONMENT,
    mode: config.MODE,
    createdAt: new Date().toISOString(),
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
      createdAt: new Date().toISOString()
    }
  };

  saveTransaction(txn);
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
  const txn = loadTransaction(txnId);
  if (!txn) throw new Error("Transaction not found.");

  const keys = keyRegistry.get(txnId) || loadOrGenerateKeys(txn);
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
    "MPI_RESPONSE_LINK",
    "MPI_RESPONSE_TYPE"
  ];

  return order.map((name, idx) => ({
    idx: String(idx + 1).padStart(2, "0"),
    name,
    value: fieldsSafe[name] || ""
  }));
}

function buildMpiReq(txnId, cardInput) {
  const txn = loadTransaction(txnId);
  if (!txn) throw new Error("Transaction not found.");
  if (!txn.mkReq.response || (txn.mkReq.response.errorCode || txn.mkReq.response.ERROR_CODE) !== "000") {
    throw new Error("mkReq must succeed before MPIReq.");
  }

  const keyData = keyRegistry.get(txnId);
  if (!keyData) {
    throw new Error("Signing key not found for transaction.");
  }

  const responseType = (cardInput.responseType || "STRING").toUpperCase();
  const wirePurchaseDate = formatUtcPurchaseDate();
  const mpiFields = {
    MPI_TRANS_TYPE: "SALES",
    MPI_MERC_ID: txn.merchantId,
    MPI_PAN: String(cardInput.cardNumber || "").replace(/\s+/g, ""),
    MPI_CARD_HOLDER_NAME: cardInput.cardHolderName || txn.customer.name || "",
    MPI_PAN_EXP: cardInput.expiry || "",
    MPI_CVV2: cardInput.cvv || "",
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
    MPI_RESPONSE_LINK: txn.responseUrl,
    MPI_RESPONSE_TYPE: responseType
  };

  const mac = generateMpiMac(keyData.privateKeyPem, mpiFields);
  mpiFields.MPI_MAC = mac.signature;

  const verifyResult = verifySha256WithRsa(
    keyData.publicKeyBase64Url,
    mac.input,
    mac.signature
  );

  runtimeMpiRegistry.set(txnId, { ...mpiFields });

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
    macPurchaseDate: canonicalMpiPurchaseDateForCardzoneMac(wirePurchaseDate),
    signInputLength: mac.input.length,
    signInputHash: mac.inputHash,
    mpiMac: mac.signature,
    mpiMacLength: mac.signature.length,
    signedValueHash: sha256Hex(canonicalMpiMacInput(mpiFields)),
    submittedValueHash: sha256Hex(canonicalMpiMacInput(mpiFields))
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
  const runtimeFields = runtimeMpiRegistry.get(txnId);
  if (!runtimeFields) {
    throw new Error("MPIReq runtime fields unavailable. Rebuild MPIReq for hosted submission.");
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
    submittedValueHash: sha256Hex(canonicalMpiMacInput(runtimeFields)),
    formSubmissionCheck:
      txn.mpiReq.signedValueHash === sha256Hex(canonicalMpiMacInput(runtimeFields))
        ? "MATCH"
        : "MISMATCH"
  };

  txn.timeline.hostedFormGenerated = "PASS";
  txn.timestamps.hostedFormGeneratedAt = new Date().toISOString();
  saveTransaction(txn);

    return `<!doctype html>
  <html>
  <head><meta charset=\"utf-8\" /><title>Cardzone UAT Redirect</title></head>
  <body>
    <h3>Redirecting to Cardzone UAT hosted payment page...</h3>
    <form id=\"mercReqForm\" method=\"POST\" action=\"${escapeHtml(config.CARDZONE_MERC_REQ_URL)}\">${inputs}</form>
    <script src="/autopost.js"></script>
    <noscript><button type="submit" form="mercReqForm">Continue to Cardzone</button></noscript>
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
  const txnId = formData.MPI_TRXN_ID;
  const txn = loadTransaction(txnId);
  if (!txn) {
    throw new Error("Callback transaction not found.");
  }

  const callbackFields = {
    MPI_MERC_ID: formData.MPI_MERC_ID || "",
    MPI_TRXN_ID: formData.MPI_TRXN_ID || "",
    MPI_MAC: formData.MPI_MAC || "",
    MPI_ERROR_CODE: formData.MPI_ERROR_CODE || "",
    MPI_ERROR_DESC: formData.MPI_ERROR_DESC || "",
    MPI_APPR_CODE: formData.MPI_APPR_CODE || "",
    MPI_RRN: formData.MPI_RRN || "",
    MPI_BIN: formData.MPI_BIN || "",
    MPI_REFERRAL_CODE: formData.MPI_REFERRAL_CODE || "",
    MPI_CARDHOLDER_INFO: formData.MPI_CARDHOLDER_INFO || ""
  };

  txn.callback.receivedAt = new Date().toISOString();
  txn.timestamps.callbackReceivedAt = txn.callback.receivedAt;
  txn.callback.fields = callbackFields;
  txn.callback.httpStatus = 200;
  txn.callback.contentType = metadata.contentType || "";
  txn.callback.source = metadata.source || "unknown";
  txn.callbackStatus = "RECEIVED";
  txn.timeline.callbackReceived = "PASS";

  const cardzonePub = txn.mkReq.cardzonePublicKey || txn.mkReq.request.pubKey;
  const verified = verifyCallbackMac(cardzonePub, callbackFields, callbackFields.MPI_MAC);
  txn.callback.macVerified = verified.ok;
  txn.callback.macInputHash = verified.inputHash;
  txn.callback.macInputLength = verified.input.length;
  txn.timestamps.callbackMacVerifiedAt = new Date().toISOString();
  txn.timeline.callbackMacVerified = verified.ok ? "PASS" : "FAIL";

  if (callbackFields.MPI_ERROR_CODE === "000" && verified.ok) {
    txn.status = "SUCCESS";
    txn.finalResult = "APPROVED";
    txn.mpiResult = "SUCCESS";
    txn.timeline.final = "PASS";
    txn.timestamps.finalAt = new Date().toISOString();
  } else if (!callbackFields.MPI_ERROR_CODE) {
    txn.status = "PENDING";
    txn.finalResult = "CALLBACK_PENDING_RESULT";
    txn.mpiResult = "PENDING";
    txn.timeline.final = "PENDING";
  } else if (callbackFields.MPI_ERROR_CODE === "5A0") {
    txn.status = "FAILED";
    txn.finalResult = "MAC_VERIFICATION_FAILED_AT_CARDZONE";
    txn.mpiResult = "5A0";
    txn.timeline.final = "FAIL";
    txn.timestamps.finalAt = new Date().toISOString();
    txn.diagnostics.cardzone5A0 = {
      title: "MAC verification failed at Cardzone.",
      explanation: "The merchant generated a locally valid signature, but Cardzone did not accept it.",
      transactionId: txn.txnId,
      merchantId: txn.merchantId,
      mkReqStatus: txn.timeline.mkreqResponse,
      publicKeyFingerprint: txn.security.mkReqPubFingerprint,
      macInputSha256: txn.mpiReq.signInputHash,
      macInputLength: txn.mpiReq.signInputLength,
      mpiMacLength: txn.mpiReq.mpiMacLength,
      keyPairMatch: txn.security.keyMatch,
      formSubmissionCheck: txn.outboundMercReq.formSubmissionCheck
    };
  } else {
    txn.status = "FAILED";
    txn.finalResult = "DECLINED_OR_ERROR";
    txn.mpiResult = callbackFields.MPI_ERROR_CODE || "UNKNOWN";
    txn.timeline.final = "FAIL";
    txn.timestamps.finalAt = new Date().toISOString();
  }

  saveTransaction(txn);
  return txn;
}

async function runInquiry(txnId) {
  const txn = loadTransaction(txnId);
  if (!txn) throw new Error("Transaction not found.");

  const keyData = keyRegistry.get(txnId);
  if (!keyData) {
    throw new Error("Cannot run inquiry: signing key is missing in runtime.");
  }

  const reqFields = {
    MPI_TRANS_TYPE: "INQ",
    MPI_MERC_ID: txn.merchantId,
    MPI_PAN: "",
    MPI_CARD_HOLDER_NAME: "",
    MPI_PAN_EXP: "",
    MPI_CVV2: "",
    MPI_TRXN_ID: `${txnId}_INQ`,
    MPI_ORI_TRXN_ID: txnId,
    MPI_PURCH_DATE: formatUtcPurchaseDate(),
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

  const mac = generateMpiMac(keyData.privateKeyPem, reqFields);
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

  txn.timeline.inquiryResult = txn.inquiry.result?.outcome || "NOT RUN";
  txn.timeline.inquiry = "PASS";
  txn.timestamps.inquiryAt = new Date().toISOString();

  if (!txn.callback?.macVerified) {
    const outcome = txn.inquiry.result?.outcome;
    if (outcome === "SUCCESS") {
      txn.status = "SUCCESS";
      txn.finalResult = "INQUIRY_SUCCESS";
      txn.mpiResult = "SUCCESS";
      txn.timeline.final = "PASS";
      txn.timestamps.finalAt = new Date().toISOString();
    } else if (outcome === "FAILED") {
      txn.status = "FAILED";
      txn.finalResult = `INQUIRY_FAILED_${txn.inquiry.result?.code || "UNKNOWN"}`;
      txn.mpiResult = txn.inquiry.result?.code || "UNKNOWN";
      txn.timeline.final = "FAIL";
      txn.timestamps.finalAt = new Date().toISOString();
    } else {
      txn.status = "PENDING";
      txn.finalResult = `INQUIRY_${outcome || "PENDING"}`;
      txn.mpiResult = "PENDING";
      txn.timeline.final = "PENDING";
    }
  }

  saveTransaction(txn);
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
    environment: config.ENVIRONMENT,
    mode: config.MODE,
    bindHost: config.BIND_HOST,
    merchantId: config.MERCHANT_ID,
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

  const dir = path.join(process.cwd(), "data", "keys");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `private_${txnId}.pem`);
  fs.writeFileSync(file, keyData.privateKeyPem, { encoding: "utf8", mode: 0o600 });
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
  CURRENCY_CONFIG
};
