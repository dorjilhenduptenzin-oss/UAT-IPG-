const express = require("express");
const Joi = require("joi");
const {
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
  saveUatPrivateKeyIfGenerated
} = require("../services/transactionService");
const { saveTransaction } = require("../storage/transactions");
const { createPaymentLink } = require("../storage/paymentLinks");
const { config } = require("../config/env");
const { logInfo } = require("../utils/logger");

const router = express.Router();

const InitiatePaymentSchema = Joi.object({
  merchantId: Joi.string().allow("").default(""),
  amountMajor: Joi.number().positive().required(),
  currency: Joi.string().valid("840", "356", "064").required(),
  customerName: Joi.string().allow("").default(""),
  customerEmail: Joi.string().allow("").default(""),
  email: Joi.string().allow("").default(""),
  customerRef: Joi.string().allow("").default(""),
  mobilePhone: Joi.string().allow("").default(""),
  cardHolderName: Joi.string().allow("").default(""),
  responseType: Joi.string().valid("STRING", "JSON").default("STRING"),
  responseUrl: Joi.string().allow("").default(""),
  billingAddress: Joi.object({
    city: Joi.string().allow("").default(""),
    state: Joi.string().allow("").default(""),
    country: Joi.string().allow("").default(""),
    postcode: Joi.string().allow("").default(""),
    line1: Joi.string().allow("").default(""),
    line2: Joi.string().allow("").default(""),
    line3: Joi.string().allow("").default("")
  }).default({}),
  shippingAddress: Joi.object({
    city: Joi.string().allow("").default(""),
    state: Joi.string().allow("").default(""),
    country: Joi.string().allow("").default(""),
    postcode: Joi.string().allow("").default(""),
    line1: Joi.string().allow("").default(""),
    line2: Joi.string().allow("").default(""),
    line3: Joi.string().allow("").default("")
  }).default({})
}).unknown(false);

const CardzoneMPIReqSchema = Joi.object({
  cardNumber: Joi.string().allow("").default(""),
  expiry: Joi.string().allow("").default(""),
  cvv: Joi.string().allow("").default(""),
  cardHolderName: Joi.string().allow("").default(""),
  responseType: Joi.string().valid("STRING", "JSON").default("STRING"),
  originalTxnId: Joi.string().allow("").default(""),
  addrMatch: Joi.string().allow("").default(""),
  homePhone: Joi.string().allow("").default(""),
  homePhoneCc: Joi.string().allow("").default(""),
  workPhone: Joi.string().allow("").default(""),
  workPhoneCc: Joi.string().allow("").default(""),
  mobilePhoneCc: Joi.string().allow("").default(""),
  lineItems: Joi.array().items(
    Joi.object({
      MPI_ITEM_ID: Joi.string().allow("").default(""),
      MPI_ITEM_REMARK: Joi.string().allow("").default(""),
      MPI_ITEM_QUANTITY: Joi.string().allow("").default(""),
      MPI_ITEM_AMOUNT: Joi.string().allow("").default(""),
      MPI_ITEM_CURRENCY: Joi.string().allow("").default("")
    })
  ).default([])
}).unknown(false);

const CardzoneMPIResSchema = Joi.object({
  MPI_MERC_ID: Joi.string().allow("").default(""),
  MPI_TRXN_ID: Joi.string().required(),
  MPI_MAC: Joi.string().allow("").default(""),
  MPI_ERROR_CODE: Joi.string().allow("").default(""),
  MPI_ERROR_DESC: Joi.string().allow("").default(""),
  MPI_APPR_CODE: Joi.string().allow("").default(""),
  MPI_RRN: Joi.string().allow("").default(""),
  MPI_BIN: Joi.string().allow("").default(""),
  MPI_REFERRAL_CODE: Joi.string().allow("").default(""),
  MPI_CARDHOLDER_INFO: Joi.string().allow("").default("")
}).unknown(true);

const CallbackSchema = CardzoneMPIResSchema;

const InquirySchema = Joi.object({}).unknown(true);

function getRequestOrigin(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "")
    .split(",")[0]
    .trim();

  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  return `${req.protocol}://${req.get("host")}`;
}

function shouldPreferRequestReturnBase() {
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT) {
    return true;
  }

  try {
    const hostname = new URL(config.RETURN_BASE_URL).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return true;
  }
}

function resolveReturnBaseUrl(req, explicitResponseUrl) {
  if (explicitResponseUrl) return undefined;
  if (!shouldPreferRequestReturnBase()) return undefined;
  return getRequestOrigin(req);
}

router.post("/initiate", async (req, res) => {
  console.log("[INITIATE_KEYS]", Object.keys(req.body || {}));
  const { error, value } = InitiatePaymentSchema.validate(req.body || {}, { abortEarly: false });
  if (error) {
    return res.status(400).send(renderErrorPage(`Validation failed: ${error.message}`));
  }

  try {
    const submittedMerchantId = String(value.merchantId || "").trim();
    if (submittedMerchantId && submittedMerchantId !== config.MERCHANT_ID) {
      logInfo("UAT_INITIATE_MERCHANT_OVERRIDE", {
        submittedMerchantId,
        effectiveMerchantId: config.MERCHANT_ID
      });
    }

    const txn = createTransaction({
      merchantId: config.MERCHANT_ID,
      amountMajor: value.amountMajor,
      currency: value.currency,
      customerName: value.customerName,
      customerEmail: value.customerEmail || value.email || "",
      mobilePhone: value.mobilePhone,
      responseUrl: value.responseUrl,
      returnBaseUrl: resolveReturnBaseUrl(req, value.responseUrl)
    });

    const afterMk = await runMkReq(txn.txnId);
    const mkErrorCode = afterMk.mkReq?.response?.errorCode || afterMk.mkReq?.response?.ERROR_CODE;
    const mkErrorDesc =
      afterMk.mkReq?.response?.errorDescription ||
      afterMk.mkReq?.response?.ERROR_DESC ||
      "mkReq rejected";

    if (mkErrorCode !== "000") {
      return res.status(400).send(
        renderErrorPage(
          `mkReq failed for transaction ${txn.txnId}: ${mkErrorCode} - ${mkErrorDesc}`
        )
      );
    }

    buildMpiReq(txn.txnId, {
      cardNumber: "",
      expiry: "",
      cvv: "",
      cardHolderName: value.cardHolderName,
      responseType: value.responseType
    });

    const hostedPage = generateHostedFormHtml(txn.txnId);
    return res.type("html").send(hostedPage);
  } catch (caught) {
    return res.status(400).send(renderErrorPage(caught.message || "Initiation failed"));
  }
});

function renderErrorPage(message) {
  const safe = String(message || "Initiation failed")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>UAT Initiate Error</title></head>
<body>
  <h3>Payment initiation failed</h3>
  <pre>${safe}</pre>
  <p><a href="/">Back to checkout</a></p>
</body>
</html>`;
}

function flowStages(txn) {
  return {
    INITIATED: txn.timeline?.created || "NOT RUN",
    MKREQ: txn.timeline?.mkreqResponse || "NOT RUN",
    MPIREQ_CREATED: txn.timeline?.mpireqCreated || txn.timeline?.mpiBuilt || "NOT RUN",
    HOSTED_FORM_GENERATED: txn.timeline?.hostedFormGenerated || "NOT RUN",
    HOSTED_FORM_SUBMITTED: txn.timeline?.hostedFormSubmitted || "NOT RUN",
    CARDZONE_RESPONSE_RECEIVED: txn.timeline?.cardzoneResponseReceived || "NOT RUN",
    CARDZONE_CARD_FORM_PRESENT: txn.timeline?.cardzoneCardFormPresent || "UNKNOWN",
    CARDZONE_REDIRECT: txn.timeline?.cardzoneRedirect || "NOT RUN",
    CALLBACK: txn.timeline?.callbackReceived || "NOT RUN",
    CALLBACK_MAC: txn.timeline?.callbackMacVerified || "NOT RUN",
    INQUIRY_REQUEST: txn.timeline?.inquiryRequest || "NOT RUN",
    INQUIRY_RESULT: txn.timeline?.inquiryResult || "NOT RUN",
    INQUIRY: txn.timeline?.inquiry || "NOT RUN",
    RETURN: txn.timeline?.returnViewed || "NOT RUN",
    FINAL_STATUS: txn.timeline?.final || "PENDING"
  };
}

function statusReason(txn) {
  if (txn.status === "SUCCESS") {
    return "Approved by issuer and callback MAC verified.";
  }

  if (txn.finalResult === "MAC_VERIFICATION_FAILED_AT_CARDZONE") {
    return "Cardzone returned MPI_ERROR_CODE=5A0 (MAC verification failed at Cardzone).";
  }

  if (txn.callback?.fields?.MPI_ERROR_CODE) {
    const code = txn.callback.fields.MPI_ERROR_CODE;
    const desc = txn.callback.fields.MPI_ERROR_DESC || "No description";
    return `Cardzone callback error ${code}: ${desc}`;
  }

  if (String(txn.finalResult || "").startsWith("BROWSER_RETURN_ERROR_")) {
    const code = txn.cardzoneReturn?.fields?.MPI_ERROR_CODE || "UNKNOWN";
    const desc = txn.cardzoneReturn?.fields?.MPI_ERROR_DESC || "No description";
    return `Cardzone browser return error ${code}: ${desc} (provisional until callback is received).`;
  }

  if (txn.timeline?.callbackReceived !== "PASS") {
    return "Callback not received yet; awaiting callback or inquiry.";
  }

  if (!txn.callback?.macVerified) {
    return "Callback received but callback MAC is unverified.";
  }

  return txn.finalResult || "Pending final result.";
}

function renderReturnPage(txn, detail) {
  const esc = (v) =>
    String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Payment Result ${esc(txn.txnId)}</title>
  <style>
    body { font-family: Segoe UI, Arial, sans-serif; margin: 24px; background: #f6f8fb; color: #0f172a; }
    .card { background: #fff; border-radius: 10px; padding: 18px; box-shadow: 0 4px 18px rgba(15,23,42,.08); max-width: 920px; }
    .ok { color: #166534; }
    .bad { color: #991b1b; }
    .pend { color: #1d4ed8; }
    pre { white-space: pre-wrap; background: #f1f5f9; border-radius: 8px; padding: 12px; overflow: auto; }
    table { border-collapse: collapse; width: 100%; }
    td { border-bottom: 1px solid #e2e8f0; padding: 6px 4px; vertical-align: top; }
    td:first-child { width: 180px; color: #334155; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Cardzone UAT Payment Result</h2>
    <p><strong>Transaction ID:</strong> ${esc(txn.txnId)}</p>
    <p><strong>Status:</strong> <span class="${txn.status === "SUCCESS" ? "ok" : txn.status === "FAILED" ? "bad" : "pend"}">${esc(txn.status)}</span></p>
    <p><strong>Reason:</strong> ${esc(detail.reason)}</p>

    <h3>Callback Details</h3>
    <table>
      <tr><td>Callback URL</td><td>${esc(config.CALLBACK_BASE_URL)}/api/callback</td></tr>
      <tr><td>Callback Reachable By Cardzone</td><td>${esc(detail.callbackReachability)}</td></tr>
      <tr><td>Callback Received</td><td>${esc(txn.callbackStatus || "WAITING")}</td></tr>
      <tr><td>Callback HTTP Status</td><td>${esc(txn.callback?.httpStatus || "NOT RUN")}</td></tr>
      <tr><td>Callback Content-Type</td><td>${esc(txn.callback?.contentType || "NOT RUN")}</td></tr>
      <tr><td>Callback MAC Verified</td><td>${esc(String(txn.callback?.macVerified ?? "NOT RUN"))}</td></tr>
      <tr><td>Callback Transaction ID</td><td>${esc(txn.callback?.fields?.MPI_TRXN_ID || "")}</td></tr>
      <tr><td>MPI_ERROR_CODE</td><td>${esc(txn.callback?.fields?.MPI_ERROR_CODE || "")}</td></tr>
      <tr><td>MPI_ERROR_DESC</td><td>${esc(txn.callback?.fields?.MPI_ERROR_DESC || "")}</td></tr>
      <tr><td>MPI_APPR_CODE</td><td>${esc(txn.callback?.fields?.MPI_APPR_CODE || "")}</td></tr>
      <tr><td>MPI_RRN</td><td>${esc(txn.callback?.fields?.MPI_RRN || "")}</td></tr>
    </table>

    <h3>Inquiry Details</h3>
    <table>
      <tr><td>Inquiry HTTP Status</td><td>${esc(txn.inquiry?.response?.status ?? "NOT RUN")}</td></tr>
      <tr><td>Inquiry Result</td><td>${esc(txn.inquiry?.result?.outcome || "NOT RUN")}</td></tr>
      <tr><td>Inquiry Code</td><td>${esc(txn.inquiry?.result?.code || "")}</td></tr>
      <tr><td>Inquiry Description</td><td>${esc(txn.inquiry?.result?.description || "")}</td></tr>
      <tr><td>Inquiry MAC Verification</td><td>${esc(String(txn.inquiry?.macVerified ?? "NOT RUN"))}</td></tr>
    </table>

    <h3>Cardzone Browser Return (Untrusted)</h3>
    <table>
      <tr><td>Return POST Received</td><td>${esc(String(Boolean(txn.cardzoneReturn?.receivedAt)))}</td></tr>
      <tr><td>Received At</td><td>${esc(txn.cardzoneReturn?.receivedAt || "")}</td></tr>
      <tr><td>Content-Type</td><td>${esc(txn.cardzoneReturn?.contentType || "")}</td></tr>
      <tr><td>MPI_TRXN_ID</td><td>${esc(txn.cardzoneReturn?.fields?.MPI_TRXN_ID || "")}</td></tr>
      <tr><td>MPI_ERROR_CODE</td><td>${esc(txn.cardzoneReturn?.fields?.MPI_ERROR_CODE || "")}</td></tr>
      <tr><td>MPI_ERROR_DESC</td><td>${esc(txn.cardzoneReturn?.fields?.MPI_ERROR_DESC || "")}</td></tr>
      <tr><td>MPI_APPR_CODE</td><td>${esc(txn.cardzoneReturn?.fields?.MPI_APPR_CODE || "")}</td></tr>
      <tr><td>MPI_RRN</td><td>${esc(txn.cardzoneReturn?.fields?.MPI_RRN || "")}</td></tr>
      <tr><td>MPI_MAC Present</td><td>${esc(txn.cardzoneReturn?.fields?.MPI_MAC ? "YES" : "NO")}</td></tr>
    </table>

    <h3>Flow Timeline</h3>
    <pre>${esc(JSON.stringify(detail.stages, null, 2))}</pre>
  </div>
</body>
</html>`;
}

router.get("/config", (req, res) => {
  res.json(getConfigView());
});

router.get("/transactions", (req, res) => {
  const filter = req.query.filter || "ALL";
  res.json({ items: getDashboard(filter) });
});

router.get("/tx/:txnId", (req, res) => {
  const txn = getTxDetail(req.params.txnId);
  if (!txn) {
    return res.status(404).json({ error: "Transaction not found" });
  }
  return res.json(txn);
});

router.post("/transactions", (req, res) => {
  const { error, value } = InitiatePaymentSchema.validate(req.body || {}, { abortEarly: false });
  if (error) {
    return res.status(400).json({ error: error.message });
  }
  const txn = createTransaction({
    ...value,
    returnBaseUrl: resolveReturnBaseUrl(req, value.responseUrl)
  });
  return res.status(201).json(txn);
});

router.post("/transactions/:txnId/mkreq", async (req, res) => {
  try {
    const txn = await runMkReq(req.params.txnId);
    return res.json({
      txnId: txn.txnId,
      mkReq: txn.mkReq,
      timeline: txn.timeline
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

router.post("/transactions/:txnId/mpireq", (req, res) => {
  try {
    const { error, value } = CardzoneMPIReqSchema.validate(req.body || {}, { abortEarly: false });
    if (error) {
      return res.status(400).json({ error: error.message });
    }

    const txn = buildMpiReq(req.params.txnId, value);
    return res.json({
      txnId: txn.txnId,
      purchaseIdEqualsMpiTrxnId: txn.txnId === txn.mpiReq.fieldsSafe.MPI_TRXN_ID,
      keyMatch: txn.security.keyMatch,
      localMacVerification: txn.security.localMacVerification,
      mpiReq: txn.mpiReq,
      timeline: txn.timeline
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

router.get("/transactions/:txnId/hosted-form", (req, res) => {
  try {
    const html = generateHostedFormHtml(req.params.txnId);
    return res.type("html").send(html);
  } catch (error) {
    return res.status(400).send(error.message);
  }
});

router.post("/callback", (req, res) => {
  try {
    const { error, value } = CallbackSchema.validate(req.body || {}, { abortEarly: false });
    if (error) {
      return res.status(400).json({ error: error.message });
    }

    const userAgent = String(req.headers["user-agent"] || "");
    const isBrowser = /Mozilla\//.test(userAgent) || Boolean(req.headers["sec-fetch-mode"]);

    const txn = processCallback(value, {
      contentType: req.headers["content-type"] || "",
      source: req.ip || "",
      fromBrowser: isBrowser
    });
    if (isBrowser) {
      return res.redirect(303, `/api/return?txnId=${encodeURIComponent(txn.txnId)}`);
    }
    return res.json({ ok: true, txnId: txn.txnId, accepted: true });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

router.post("/transactions/:txnId/hosted-form-submitted", (req, res) => {
  const txn = getTxDetail(req.params.txnId);
  if (!txn) {
    return res.status(404).json({ error: "Transaction not found" });
  }

  const browserPurchaseDate = String(req.body?.finalHtmlMpiPurchDate || "");
  const browserPurchaseId = String(req.body?.finalHtmlPurchaseId || "");
  const browserMerchantId = String(req.body?.finalHtmlMerchantId || "");

  logInfo("UAT_BROWSER_PRE_SUBMIT_FORM_VALUES", {
    transactionId: req.params.txnId,
    BROWSER_FINAL_HTML_MPI_PURCH_DATE: browserPurchaseDate,
    BROWSER_FINAL_HTML_MPI_PURCH_DATE_URLENCODED: encodeURIComponent(browserPurchaseDate),
    BROWSER_FINAL_HTML_PURCHASE_ID: browserPurchaseId,
    BROWSER_FINAL_HTML_MERCHANT_ID: browserMerchantId
  });

  txn.timeline.hostedFormSubmitted = "PASS";
  txn.timeline.hostedSubmitted = "PASS";
  txn.timestamps.hostedFormSubmittedAt = new Date().toISOString();
  saveTransaction(txn);

  return res.status(204).end();
});

router.get("/return", async (req, res) => {
  const txnId = req.query.txnId;
  if (!txnId) {
    return res.status(400).send("Missing txnId");
  }
  let txn = getTxDetail(txnId);
  if (!txn) {
    return res.status(404).send("Transaction not found");
  }

  // Track browser return stage for audit timeline.
  txn.timeline.returnViewed = "PASS";
  txn.timestamps.returnViewedAt = new Date().toISOString();
  saveTransaction(txn);

  const browserReturnCode = String(txn.cardzoneReturn?.fields?.MPI_ERROR_CODE || "");
  const shouldSkipInquiryFromBrowserError =
    !txn.callback?.macVerified && browserReturnCode && browserReturnCode !== "000";
  const needsInquiry = !txn.callback?.macVerified && !shouldSkipInquiryFromBrowserError;
  if (needsInquiry) {
    try {
      await runInquiry(txnId);
      txn = getTxDetail(txnId) || txn;
    } catch {
      // Keep the best-known transaction state when inquiry is unavailable.
    }
  }

  const detail = {
    stages: flowStages(txn),
    reason: statusReason(txn),
    callbackReachability:
      /localhost|127\.0\.0\.1/i.test(config.CALLBACK_BASE_URL)
        ? "NO (localhost cannot be called by remote Cardzone servers)"
        : "UNKNOWN (depends on network routing/firewall/reverse proxy)"
  };

  return res.type("html").send(renderReturnPage(txn, detail));
});

router.post("/return", (req, res) => {
  const txnId = req.body.txnId || req.query.txnId;
  if (!txnId) {
    return res.status(400).json({ error: "Missing txnId" });
  }

  const txn = getTxDetail(txnId);
  if (txn) {
    const fields = {
      MPI_MERC_ID: req.body.MPI_MERC_ID || "",
      MPI_TRXN_ID: req.body.MPI_TRXN_ID || req.query.txnId || "",
      MPI_MAC: req.body.MPI_MAC || "",
      MPI_ERROR_CODE: req.body.MPI_ERROR_CODE || "",
      MPI_ERROR_DESC: req.body.MPI_ERROR_DESC || "",
      MPI_APPR_CODE: req.body.MPI_APPR_CODE || "",
      MPI_RRN: req.body.MPI_RRN || "",
      MPI_BIN: req.body.MPI_BIN || "",
      MPI_REFERRAL_CODE: req.body.MPI_REFERRAL_CODE || ""
    };

    txn.cardzoneReturn = {
      receivedAt: new Date().toISOString(),
      contentType: req.headers["content-type"] || "",
      source: req.ip || "",
      fields
    };

    const referer = String(req.headers.referer || "");
    const secFetchSite = String(req.headers["sec-fetch-site"] || "");
    if (referer.includes("uatczsecure.bob.bt") || secFetchSite === "cross-site") {
      txn.timeline.cardzoneResponseReceived = "PASS";
      txn.timeline.cardzoneRedirect = "PASS";
      txn.timeline.cardzonePageLoaded = "UNKNOWN";
      txn.timestamps.cardzoneResponseReceivedAt = new Date().toISOString();
    }

    const browserErrorCode = String(fields.MPI_ERROR_CODE || "");
    if (!txn.callback?.macVerified && browserErrorCode && browserErrorCode !== "000") {
      txn.status = "FAILED";
      txn.mpiResult = browserErrorCode;
      txn.finalResult = `BROWSER_RETURN_ERROR_${browserErrorCode}`;
      txn.timeline.final = "FAIL";
      txn.timestamps.finalAt = new Date().toISOString();
      txn.diagnostics.browserReturnFallback = {
        provisional: true,
        code: browserErrorCode,
        description: String(fields.MPI_ERROR_DESC || "")
      };
      logInfo("UAT_BROWSER_RETURN_FALLBACK_STATUS", {
        transactionId: txnId,
        BROWSER_RETURN_MPI_ERROR_CODE: browserErrorCode,
        BROWSER_RETURN_FINAL_RESULT: txn.finalResult
      });
    }

    saveTransaction(txn);
  }

  return res.redirect(303, `/api/return?txnId=${encodeURIComponent(txnId)}`);
});

router.post("/transactions/:txnId/inquiry", async (req, res) => {
  try {
    const { error } = InquirySchema.validate(req.body || {}, { abortEarly: false });
    if (error) {
      return res.status(400).json({ error: error.message });
    }

    const txn = await runInquiry(req.params.txnId);
    return res.json({
      txnId: txn.txnId,
      inquiry: txn.inquiry,
      timeline: txn.timeline,
      finalStatus: txn.status
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

router.get("/transactions/:txnId/diagnostic", (req, res) => {
  try {
    const report = exportSafeDiagnostic(req.params.txnId);
    return res.json(report);
  } catch (error) {
    return res.status(404).json({ error: error.message });
  }
});

router.post("/transactions/:txnId/persist-key", (req, res) => {
  try {
    const keyPath = saveUatPrivateKeyIfGenerated(req.params.txnId);
    if (!keyPath) {
      return res.status(404).json({ error: "Key not found in runtime" });
    }
    return res.json({
      message: "Private key saved for local UAT only",
      keyPath
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

router.post("/payment-links", (req, res) => {
  const txnId = req.body.txnId;
  if (!txnId) return res.status(400).json({ error: "txnId required" });
  const ttlMinutes = Number(req.body.ttlMinutes || 30);
  const link = createPaymentLink(txnId, ttlMinutes);
  return res.status(201).json(link);
});

module.exports = router;
