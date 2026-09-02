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
  MPI_TRXN_ID: Joi.string().allow("").default(""),
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

router.post("/initiate", async (req, res) => {
  const { error, value } = InitiatePaymentSchema.validate(req.body || {}, { abortEarly: false });
  if (error) {
    return res.status(400).send(renderErrorPage(`Validation failed: ${error.message}`));
  }

  try {
    const submittedMerchantId = String(value.merchantId || "").trim();
    const effectiveMerchantId = submittedMerchantId || config.MERCHANT_ID;
    if (submittedMerchantId && submittedMerchantId !== config.MERCHANT_ID) {
      logInfo("UAT_INITIATE_MERCHANT_OVERRIDE", {
        submittedMerchantId,
        effectiveMerchantId
      });
    }

    const txn = createTransaction({
      merchantId: effectiveMerchantId,
      amountMajor: value.amountMajor,
      currency: value.currency,
      customerName: value.customerName,
      customerEmail: value.customerEmail || value.email || "",
      mobilePhone: value.mobilePhone,
      responseUrl: value.responseUrl
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
  const hasTrustedCallback = Boolean(txn.callbackMacVerified || txn.callback?.macVerified);
  const hasTrustedInquiry = Boolean(txn.inquiry?.macVerified || (txn.inquiry?.result?.outcome && txn.inquiry?.result?.outcome !== "PROCESSING"));

  if (hasTrustedCallback) {
    const code = txn.callback?.responseCode || txn.callback?.fields?.MPI_ERROR_CODE || "";
    const desc = txn.callback?.responseDescription || txn.callback?.fields?.MPI_ERROR_DESC || "";
    if (txn.status === "SUCCESS") {
      return `Approved by issuer via trusted server callback (Code: ${code}, Approval: ${txn.callback?.approvalCode || "YES"}).`;
    }
    if (code === "5A0") {
      return "Cardzone callback returned MPI_ERROR_CODE=5A0 (MAC verification failed at Cardzone).";
    }
    return `Declined/Error via trusted server callback: ${code} - ${desc || "No description"}`;
  }

  if (hasTrustedInquiry) {
    const code = txn.inquiry?.result?.code || "";
    const desc = txn.inquiry?.result?.description || "";
    if (txn.status === "SUCCESS") {
      return `Approved via verified inquiry fallback (Code: ${code}).`;
    }
    return `Inquiry returned outcome ${txn.inquiry?.result?.outcome || "FAILED"}: ${code} - ${desc || "No description"}`;
  }

  if (txn.cardzoneReturn?.fields?.MPI_ERROR_CODE) {
    const code = txn.cardzoneReturn.fields.MPI_ERROR_CODE;
    const desc = txn.cardzoneReturn.fields.MPI_ERROR_DESC || "";
    return `Cardzone browser return: ${code} - ${desc} (Untrusted diagnostic only, awaiting trusted server callback).`;
  }

  return "Transaction is pending trusted callback confirmation from Cardzone.";
}

function renderReturnPage(txn, detail) {
  const esc = (v) =>
    String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;");

  const trustedSource = (txn.callbackMacVerified || txn.callback?.macVerified)
    ? "Trusted Server Callback"
    : (txn.inquiry?.macVerified || (txn.inquiry?.result?.outcome && txn.inquiry?.result?.outcome !== "PROCESSING"))
    ? "Verified Cardzone Inquiry"
    : "None (Pending / Untrusted)";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Payment Result ${esc(txn.txnId)}</title>
  <style>
    body { font-family: Segoe UI, Arial, sans-serif; margin: 24px; background: #f6f8fb; color: #0f172a; }
    .card { background: #fff; border-radius: 10px; padding: 18px; box-shadow: 0 4px 18px rgba(15,23,42,.08); max-width: 920px; }
    .ok { color: #166534; font-weight: bold; }
    .bad { color: #991b1b; font-weight: bold; }
    .pend { color: #1d4ed8; font-weight: bold; }
    pre { white-space: pre-wrap; background: #f1f5f9; border-radius: 8px; padding: 12px; overflow: auto; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 16px; }
    td { border-bottom: 1px solid #e2e8f0; padding: 6px 4px; vertical-align: top; }
    td:first-child { width: 220px; color: #334155; font-weight: 500; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Cardzone UAT Payment Result</h2>
    <p><strong>Transaction ID:</strong> ${esc(txn.txnId)}</p>
    <p><strong>Status:</strong> <span class="${txn.status === "SUCCESS" ? "ok" : txn.status === "FAILED" ? "bad" : "pend"}">${esc(txn.status)}</span></p>
    <p><strong>Trusted Result Source:</strong> <span>${esc(trustedSource)}</span></p>
    <p><strong>Reason:</strong> ${esc(detail.reason)}</p>

    <h3>1. Trusted Server Callback Details</h3>
    <table>
      <tr><td>Expected Callback URL</td><td>${esc(config.CALLBACK_BASE_URL)}/api/callback</td></tr>
      <tr><td>Callback Reachability</td><td>${esc(detail.callbackReachability)}</td></tr>
      <tr><td>Callback Received</td><td>${esc(txn.callbackReceived ? "YES" : (txn.callbackStatus || "WAITING"))}</td></tr>
      <tr><td>Callback MAC Verified</td><td>${esc(String(txn.callbackMacVerified ?? txn.callback?.macVerified ?? "NOT RUN"))}</td></tr>
      <tr><td>Callback Transaction ID</td><td>${esc(txn.callback?.fields?.MPI_TRXN_ID || "")}</td></tr>
      <tr><td>MPI_ERROR_CODE</td><td>${esc(txn.callback?.responseCode || txn.callback?.fields?.MPI_ERROR_CODE || "")}</td></tr>
      <tr><td>MPI_ERROR_DESC</td><td>${esc(txn.callback?.responseDescription || txn.callback?.fields?.MPI_ERROR_DESC || "")}</td></tr>
      <tr><td>MPI_APPR_CODE</td><td>${esc(txn.callback?.approvalCode || txn.callback?.fields?.MPI_APPR_CODE || "")}</td></tr>
      <tr><td>MPI_RRN</td><td>${esc(txn.callback?.RRN || txn.callback?.fields?.MPI_RRN || "")}</td></tr>
      <tr><td>MPI_BIN</td><td>${esc(txn.callback?.BIN || txn.callback?.fields?.MPI_BIN || "")}</td></tr>
      <tr><td>MPI_REFERRAL_CODE</td><td>${esc(txn.callback?.referralCode || txn.callback?.fields?.MPI_REFERRAL_CODE || "")}</td></tr>
      <tr><td>MPI_CARDHOLDER_INFO</td><td>${esc(txn.callback?.cardholderInfo || txn.callback?.fields?.MPI_CARDHOLDER_INFO || "")}</td></tr>
    </table>

    <h3>2. Cardzone Inquiry Fallback Details</h3>
    <table>
      <tr><td>Inquiry HTTP Status</td><td>${esc(txn.inquiry?.response?.status ?? "NOT RUN")}</td></tr>
      <tr><td>Inquiry Result</td><td>${esc(txn.inquiry?.result?.outcome || "NOT RUN")}</td></tr>
      <tr><td>Inquiry Code</td><td>${esc(txn.inquiry?.result?.code || "")}</td></tr>
      <tr><td>Inquiry Description</td><td>${esc(txn.inquiry?.result?.description || "")}</td></tr>
      <tr><td>Inquiry MAC Verification</td><td>${esc(String(txn.inquiry?.macVerified ?? "NOT RUN"))}</td></tr>
    </table>

    <h3>3. Cardzone Browser Return (Untrusted Diagnostic Only)</h3>
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

    <p><a href="/">Back to checkout</a></p>
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
    ...value
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

function handleCallbackRequest(req, res) {
  try {
    console.log("[INFO] CALLBACK_ROUTE_HIT=true");
    const mergedPayload = {
      ...(req.query || {}),
      ...(req.body || {})
    };

    logInfo("MERCHANT_RESULT_ROUTE_HIT", {
      routeHit: true,
      method: req.method,
      contentType: req.headers["content-type"] || "",
      bodyKeys: Object.keys(mergedPayload),
      ip: req.ip || ""
    });

    logInfo("CALLBACK_ROUTE_HIT", {
      routeHit: true,
      method: req.method,
      contentType: req.headers["content-type"] || "",
      bodyKeys: Object.keys(mergedPayload),
      ip: req.ip || ""
    });
    logInfo("CALLBACK_METHOD", { method: req.method });
    logInfo("CALLBACK_CONTENT_TYPE", { contentType: req.headers["content-type"] || "" });

    // Allow harmless test/diagnostic ping requests
    if (mergedPayload.ping || mergedPayload.test) {
      return res.json({ ok: true, ping: true, message: "Callback endpoint reachable" });
    }

    const { error, value } = CallbackSchema.validate(mergedPayload, { abortEarly: false });
    if (error) {
      return res.status(400).json({ error: error.message });
    }

    const userAgent = String(req.headers["user-agent"] || "");
    const isBrowser = /Mozilla\//.test(userAgent) || Boolean(req.headers["sec-fetch-mode"]);

    const txn = processCallback(value, {
      contentType: req.headers["content-type"] || "",
      source: req.ip || "",
      fromBrowser: isBrowser,
      query: req.query || {}
    });

    if (isBrowser) {
      return res.redirect(303, `/api/return?txnId=${encodeURIComponent(txn.txnId)}`);
    }
    return res.json({ ok: true, txnId: txn.txnId, accepted: true });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
}

router.post("/callback", handleCallbackRequest);
router.get("/callback", handleCallbackRequest);

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
  logInfo("RETURN_ROUTE_HIT", {
    method: "GET",
    txnId
  });

  if (!txnId) {
    return res.status(400).send("Missing txnId");
  }

  logInfo("RETURN_TXN_ID", {
    transactionId: txnId
  });

  let txn = getTxDetail(txnId);
  if (!txn) {
    return res.status(404).send("Transaction not found");
  }

  // Track browser return stage for audit timeline.
  txn.timeline.returnViewed = "PASS";
  txn.timestamps.returnViewedAt = new Date().toISOString();
  saveTransaction(txn);

  const isCallbackReceived = Boolean(txn.callbackReceived || txn.callback?.receivedAt);
  const isCallbackVerified = Boolean(txn.callbackMacVerified || txn.callback?.macVerified);

  logInfo("RETURN_CALLBACK_RECEIVED", {
    transactionId: txnId,
    callbackReceived: isCallbackReceived
  });

  logInfo("RETURN_CALLBACK_MAC_VERIFIED", {
    transactionId: txnId,
    callbackMacVerified: isCallbackVerified
  });

  if (!isCallbackVerified) {
    try {
      await runInquiry(txnId);
      txn = getTxDetail(txnId) || txn;
    } catch {
      // Keep best-known transaction state if inquiry is unavailable.
    }
  }

  const isInquiryVerified = Boolean(txn.inquiry?.macVerified || (txn.inquiry?.result?.outcome && txn.inquiry?.result?.outcome !== "PROCESSING"));
  const trustedSource = isCallbackVerified
    ? "callback"
    : isInquiryVerified
    ? "inquiry"
    : (txn.finalResult?.source || "none");

  logInfo("RETURN_TRUSTED_RESULT_SOURCE", {
    transactionId: txnId,
    source: trustedSource,
    status: txn.status
  });

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
  const txnId = req.body.txnId || req.query.txnId || req.body.MPI_TRXN_ID;
  logInfo("RETURN_ROUTE_HIT", {
    method: "POST",
    txnId,
    contentType: req.headers["content-type"] || ""
  });

  if (!txnId) {
    return res.status(400).json({ error: "Missing txnId" });
  }

  logInfo("RETURN_TXN_ID", {
    transactionId: txnId
  });

  const txn = getTxDetail(txnId);
  if (txn) {
    const fields = {
      MPI_MERC_ID: req.body.MPI_MERC_ID || "",
      MPI_TRXN_ID: req.body.MPI_TRXN_ID || txnId || "",
      MPI_MAC: req.body.MPI_MAC || "",
      MPI_ERROR_CODE: req.body.MPI_ERROR_CODE || "",
      MPI_ERROR_DESC: req.body.MPI_ERROR_DESC || "",
      MPI_APPR_CODE: req.body.MPI_APPR_CODE || "",
      MPI_RRN: req.body.MPI_RRN || "",
      MPI_BIN: req.body.MPI_BIN || "",
      MPI_REFERRAL_CODE: req.body.MPI_REFERRAL_CODE || "",
      MPI_CARDHOLDER_INFO: req.body.MPI_CARDHOLDER_INFO || ""
    };

    txn.cardzoneReturn = {
      receivedAt: new Date().toISOString(),
      contentType: req.headers["content-type"] || "",
      source: req.ip || "",
      fields
    };

    txn.diagnostics = txn.diagnostics || {};
    txn.diagnostics.browserReturn = {
      untrusted: true,
      receivedAt: txn.cardzoneReturn.receivedAt,
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
