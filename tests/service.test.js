const fs = require("fs");
const path = require("path");

process.env.MODE = "MOCK";

const {
  createTransaction,
  runMkReq,
  buildMpiReq,
  generateHostedFormHtml,
  processCallback,
  runInquiry,
  getTxDetail,
  toMinorUnits
} = require("../src/services/transactionService");
const { canonicalCallbackMacInput } = require("../src/cardzone/mpi");
const { generateRsa2048KeyPair, signSha256WithRsa } = require("../src/crypto/rsa");

function cleanupTxnFiles() {
  const dir = path.join(process.cwd(), "data", "transactions");
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir);
  for (const f of files) {
    if (f.startsWith("txn_")) {
      fs.unlinkSync(path.join(dir, f));
    }
  }
}

beforeEach(() => {
  cleanupTxnFiles();
});

test("amount conversion supports USD INR BTN", () => {
  expect(toMinorUnits("1.00", "840")).toBe(100);
  expect(toMinorUnits("10.00", "356")).toBe(1000);
  expect(toMinorUnits("100.00", "064")).toBe(10000);
});

test("purchaseId equals MPI_TRXN_ID across mkReq and MPIReq", async () => {
  const txn = createTransaction({ merchantId: "863990035600270", amountMajor: 1, currency: "840" });
  const afterMk = await runMkReq(txn.txnId);
  expect(afterMk.mkReq.request.purchaseId).toBe(txn.txnId);

  const afterMpi = buildMpiReq(txn.txnId, {
    cardNumber: "4111111111111111",
    expiry: "1228",
    cvv: "123",
    responseType: "STRING"
  });
  expect(afterMpi.mpiReq.fieldsSafe.MPI_TRXN_ID).toBe(txn.txnId);
});

test("hosted HTML form contains fields and preserves MPI_MAC", async () => {
  const txn = createTransaction({ merchantId: "863990035600270", amountMajor: 1, currency: "840" });
  await runMkReq(txn.txnId);
  const built = buildMpiReq(txn.txnId, {
    cardNumber: "4111111111111111",
    expiry: "1228",
    cvv: "123"
  });

  const originalMac = built.mpiReq.mpiMac;
  const html = generateHostedFormHtml(txn.txnId);
  expect(html).toContain("method=\"POST\"");
  expect(html).toContain("MPI_MAC");

  const latest = getTxDetail(txn.txnId);
  expect(latest.outboundMercReq.formSubmissionCheck).toBe("MATCH");
  expect(latest.mpiReq.mpiMac).toBe(originalMac);
});

test("callback parsing and final status mapping for 5A0", async () => {
  const txn = createTransaction({ merchantId: "863990035600270", amountMajor: 1, currency: "840" });
  await runMkReq(txn.txnId);
  buildMpiReq(txn.txnId, { cardNumber: "4111111111111111", expiry: "1228", cvv: "123" });
  generateHostedFormHtml(txn.txnId);

  const out = processCallback({
    MPI_MERC_ID: "863990035600270",
    MPI_TRXN_ID: txn.txnId,
    MPI_MAC: "invalid",
    MPI_ERROR_CODE: "5A0",
    MPI_ERROR_DESC: "MAC ERROR"
  });

  expect(out.status).toBe("FAILED");
  expect(out.mpiResult).toBe("5A0");
  expect(out.diagnostics.cardzone5A0).toBeDefined();
});

test("callback MAC verification helper can pass with matching signature", () => {
  const keys = generateRsa2048KeyPair();
  const callback = {
    MPI_MERC_ID: "863",
    MPI_TRXN_ID: "T1",
    MPI_ERROR_CODE: "000",
    MPI_APPR_CODE: "A1",
    MPI_RRN: "R1",
    MPI_BIN: "B1",
    MPI_REFERRAL_CODE: "",
    MPI_CARDHOLDER_INFO: "OK"
  };
  const input = canonicalCallbackMacInput(callback);
  const mac = signSha256WithRsa(keys.privateKeyPem, input);
  const ok = require("../src/cardzone/mpi").verifyCallbackMac(keys.publicKeyBase64Url, callback, mac);
  expect(ok.ok).toBe(true);
});

test("inquiry request generation sets INQ and original txn id", async () => {
  const txn = createTransaction({ merchantId: "863990035600270", amountMajor: 1, currency: "840" });
  await runMkReq(txn.txnId);
  buildMpiReq(txn.txnId, { cardNumber: "4111111111111111", expiry: "1228", cvv: "123" });
  const inq = await runInquiry(txn.txnId);
  expect(inq.inquiry.request.MPI_TRANS_TYPE).toBe("INQ");
  expect(inq.inquiry.request.MPI_ORI_TRXN_ID).toBe(txn.txnId);
});

test("duplicate transaction protection triggers when id already exists", () => {
  jest.resetModules();
  jest.doMock("../src/storage/transactions", () => ({
    saveTransaction: jest.fn(),
    loadTransaction: jest.fn(),
    transactionExists: jest.fn(() => true),
    listRecentTransactions: jest.fn(() => [])
  }));
  const svc = require("../src/services/transactionService");
  expect(() =>
    svc.createTransaction({ merchantId: "863990035600270", amountMajor: 1, currency: "840" })
  ).toThrow("Duplicate transaction ID generated. Retry.");
});

test("configured UAT merchant is authoritative", () => {
  expect(() =>
    createTransaction({ merchantId: "863990030700270", amountMajor: 1, currency: "840" })
  ).toThrow("merchantId must match configured UAT merchant: 863990035600270");
});

