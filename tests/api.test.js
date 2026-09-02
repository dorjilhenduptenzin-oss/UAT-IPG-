process.env.MODE = "MOCK";

const request = require("supertest");
const { signSha256WithRsa } = require("../src/crypto/rsa");
const { canonicalCallbackMacInput } = require("../src/cardzone/mpi");
const { loadTxnPrivateKey } = require("../src/services/transactionService");
const app = require("../src/app");

test("GET /health returns environment metadata", async () => {
  const res = await request(app).get("/health");
  expect(res.status).toBe(200);
  expect(res.body.environment).toBe("UAT");
});

test("GET / returns dashboard", async () => {
  const res = await request(app).get("/");
  expect(res.status).toBe(200);
  expect(res.text).toContain("CARDZONE 3DS / IPG");
});

test("POST /api/callback parses payload and updates transaction state", async () => {
  const createRes = await request(app).post("/api/transactions").send({
    merchantId: "863990035600270",
    amountMajor: 1.0,
    currency: "840"
  });
  expect(createRes.status).toBe(201);
  const txnId = createRes.body.txnId;

  const mkReqRes = await request(app).post(`/api/transactions/${encodeURIComponent(txnId)}/mkreq`);
  expect(mkReqRes.status).toBe(200);

  const callbackRes = await request(app)
    .post("/api/callback")
    .set("Content-Type", "application/x-www-form-urlencoded")
    .send(
      `MPI_MERC_ID=863990035600270&MPI_TRXN_ID=${encodeURIComponent(txnId)}&MPI_ERROR_CODE=&MPI_APPR_CODE=&MPI_RRN=&MPI_BIN=&MPI_REFERRAL_CODE=&MPI_MAC=`
    );

  expect(callbackRes.status).toBe(200);
  expect(callbackRes.body.ok).toBe(true);
  expect(callbackRes.body.txnId).toBe(txnId);

  const txRes = await request(app).get(`/api/tx/${encodeURIComponent(txnId)}`);
  expect(txRes.status).toBe(200);
  expect(txRes.body.callbackStatus).toBe("RECEIVED");
  expect(txRes.body.timeline.callbackReceived).toBe("PASS");
  expect(txRes.body.callback.fields.MPI_TRXN_ID).toBe(txnId);
});

test("POST /api/return records untrusted browser return and redirects to GET /api/return", async () => {
  const createRes = await request(app).post("/api/transactions").send({
    merchantId: "863990035600270",
    amountMajor: 1.0,
    currency: "840"
  });
  expect(createRes.status).toBe(201);
  const txnId = createRes.body.txnId;

  const mkReqRes = await request(app).post(`/api/transactions/${encodeURIComponent(txnId)}/mkreq`);
  expect(mkReqRes.status).toBe(200);

  const mpireqRes = await request(app)
    .post(`/api/transactions/${encodeURIComponent(txnId)}/mpireq`)
    .send({ cardNumber: "", expiry: "", cvv: "", responseType: "STRING" });
  expect(mpireqRes.status).toBe(200);

  const returnRes = await request(app)
    .post("/api/return")
    .set("referer", "https://uatczsecure.bob.bt/3dss/mercReq")
    .set("sec-fetch-site", "cross-site")
    .set("Content-Type", "application/x-www-form-urlencoded")
    .send(
      `txnId=${encodeURIComponent(txnId)}&MPI_MERC_ID=863990035600270&MPI_TRXN_ID=${encodeURIComponent(txnId)}&MPI_ERROR_CODE=305&MPI_ERROR_DESC=${encodeURIComponent("Cardholder Account Number is not in a range belonging to Issuer.")}&MPI_MAC=test`
    );

  expect(returnRes.status).toBe(303);
  expect(returnRes.headers.location).toBe(`/api/return?txnId=${encodeURIComponent(txnId)}`);

  const txRes = await request(app).get(`/api/tx/${encodeURIComponent(txnId)}`);
  expect(txRes.status).toBe(200);
  expect(txRes.body.cardzoneReturn).toBeDefined();
  expect(txRes.body.cardzoneReturn.fields.MPI_ERROR_CODE).toBe("305");
  expect(txRes.body.diagnostics.browserReturn.untrusted).toBe(true);

  // GET /api/return should render the return page with diagnostic details
  const getReturnRes = await request(app).get(`/api/return?txnId=${encodeURIComponent(txnId)}`);
  expect(getReturnRes.status).toBe(200);
  expect(getReturnRes.text).toContain("Payment Result");
});

test("POST /api/callback responds to ping and handles verified callback before return", async () => {
  // Test harmless diagnostic ping
  const pingRes = await request(app)
    .post("/api/callback")
    .set("Content-Type", "application/json")
    .send({ ping: true });
  expect(pingRes.status).toBe(200);
  expect(pingRes.body.ok).toBe(true);

  // Test full flow with trusted callback
  const createRes = await request(app).post("/api/transactions").send({
    merchantId: "863990035600270",
    amountMajor: 1.0,
    currency: "840"
  });
  expect(createRes.status).toBe(201);
  const txnId = createRes.body.txnId;

  const mkReqRes = await request(app).post(`/api/transactions/${encodeURIComponent(txnId)}/mkreq`);
  expect(mkReqRes.status).toBe(200);

  const mpireqRes = await request(app)
    .post(`/api/transactions/${encodeURIComponent(txnId)}/mpireq`)
    .send({ cardNumber: "", expiry: "", cvv: "", responseType: "STRING" });
  expect(mpireqRes.status).toBe(200);

  const privKey = loadTxnPrivateKey(txnId);
  const callbackFields = {
    MPI_MERC_ID: "863990035600270",
    MPI_TRXN_ID: txnId,
    MPI_ERROR_CODE: "000",
    MPI_APPR_CODE: "APPR01",
    MPI_RRN: "RRN123",
    MPI_BIN: "411111",
    MPI_REFERRAL_CODE: "",
    MPI_CARDHOLDER_INFO: ""
  };
  const macInput = canonicalCallbackMacInput(callbackFields);
  const signature = signSha256WithRsa(privKey, macInput);

  // Callback arrives from Cardzone
  const callbackRes = await request(app)
    .post("/api/callback")
    .set("Content-Type", "application/x-www-form-urlencoded")
    .send(
      `MPI_MERC_ID=863990035600270&MPI_TRXN_ID=${encodeURIComponent(txnId)}&MPI_ERROR_CODE=000&MPI_APPR_CODE=APPR01&MPI_RRN=RRN123&MPI_BIN=411111&MPI_REFERRAL_CODE=&MPI_MAC=${encodeURIComponent(signature)}`
    );
  expect(callbackRes.status).toBe(200);
  expect(callbackRes.body.ok).toBe(true);

  // Browser return loads saved callback
  const returnRes = await request(app).get(`/api/return?txnId=${encodeURIComponent(txnId)}`);
  expect(returnRes.status).toBe(200);
  expect(returnRes.text).toContain("Approved");

  const txRes = await request(app).get(`/api/tx/${encodeURIComponent(txnId)}`);
  expect(txRes.status).toBe(200);
  expect(txRes.body.status).toBe("SUCCESS");
  expect(txRes.body.finalResult.source).toBe("callback");
});

