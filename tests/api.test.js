const request = require("supertest");

process.env.MODE = "MOCK";

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
    merchantId: "863990030700270",
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
      `MPI_MERC_ID=863990030700270&MPI_TRXN_ID=${encodeURIComponent(txnId)}&MPI_ERROR_CODE=&MPI_APPR_CODE=&MPI_RRN=&MPI_BIN=&MPI_REFERRAL_CODE=&MPI_MAC=`
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
