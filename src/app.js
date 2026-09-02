const express = require("express");
const helmet = require("helmet");
const morgan = require("morgan");
const path = require("path");
const { config } = require("./config/env");
const { getConfigView } = require("./services/transactionService");
const { getPaymentLink } = require("./storage/paymentLinks");
const apiRoutes = require("./routes/api");

const app = express();

function getDevConnectSrcOrigins() {
  const origins = new Set(["'self'", "http://localhost:4001", "http://127.0.0.1:4001"]);
  try {
    const callbackOrigin = new URL(config.CALLBACK_BASE_URL).origin;
    origins.add(callbackOrigin);
  } catch {
    // Ignore invalid callback URL; fallback to localhost origins only.
  }
  try {
    const returnOrigin = new URL(config.RETURN_BASE_URL).origin;
    origins.add(returnOrigin);
  } catch {
    // Ignore invalid return URL; fallback to localhost origins only.
  }
  return Array.from(origins);
}

function buildCspHeaderValue() {
  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction) {
    return [
      "default-src 'self'",
      "base-uri 'self'",
      "connect-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "form-action 'self' https://uatczsecure.bob.bt",
      "frame-ancestors 'none'"
    ].join("; ");
  }

  const connectSrc = getDevConnectSrcOrigins().join(" ");
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src " + connectSrc,
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "form-action 'self' https://uatczsecure.bob.bt",
    "frame-ancestors 'self'"
  ].join("; ");
}

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", buildCspHeaderValue());
  next();
});
app.use(morgan("dev"));
app.use((req, res, next) => {
  console.log(`[ROUTE] ${req.method} ${req.path}`);
  next();
});
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

app.get("/", (req, res) => {
  return res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

app.get("/favicon.ico", (req, res) => {
  return res.status(204).end();
});

// Compatibility fallback: if any stale page posts to /, forward to /api/initiate.
app.post("/", (req, res) => {
  const keys = Object.keys(req.body || {});
  const hasInitiateShape =
    keys.includes("merchantId") || keys.includes("amountMajor") || keys.includes("currency");
  const hasCallbackShape =
    keys.includes("MPI_TRXN_ID") || keys.includes("MPI_ERROR_CODE") || keys.includes("MPI_MAC");

  if (hasInitiateShape) {
    return res.redirect(307, "/api/initiate");
  }
  if (hasCallbackShape) {
    return res.redirect(307, "/api/callback");
  }

  return res.redirect(307, "/api/initiate");
});

app.use(express.static(path.join(process.cwd(), "public")));
app.use("/api", apiRoutes);

app.get("/pay/:token", (req, res) => {
  const link = getPaymentLink(req.params.token);
  if (!link) {
    return res.status(404).send("Payment link missing or expired");
  }
  return res.redirect(`/api/transactions/${encodeURIComponent(link.txnId)}/hosted-form`);
});

app.get("/health", async (req, res) => {
  let connectivity = "not-tested";
  if (config.MODE === "MOCK") {
    connectivity = "mock-mode";
  }
  res.json({
    environment: config.ENVIRONMENT,
    mode: config.MODE,
    serverTime: new Date().toISOString(),
    configurationLoaded: true,
    cardzoneConnectivityStatus: connectivity
  });
});

app.get("/api/readonly-uat-params", (req, res) => {
  res.json(getConfigView());
});

module.exports = app;
