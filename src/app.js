const express = require("express");
const helmet = require("helmet");
const morgan = require("morgan");
const path = require("path");
const { config } = require("./config/env");
const { getConfigView } = require("./services/transactionService");
const { getPaymentLink } = require("./storage/paymentLinks");
const apiRoutes = require("./routes/api");

const app = express();

function buildCspHeaderValue() {
  return [
    "default-src 'self' 'unsafe-inline'",
    "base-uri 'self'",
    "connect-src * 'self' data: blob:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src * 'self' data: blob:",
    "font-src 'self' data:",
    // Hosted payment is a top-level POST to Cardzone (their mercReq response
    // sets X-Frame-Options: DENY, so it cannot be iframed).
    "form-action 'self' https://uatczsecure.bob.bt",
    "frame-ancestors *"
  ].join("; ");
}

app.use(
  helmet({
    contentSecurityPolicy: false,
    frameguard: false
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
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

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
