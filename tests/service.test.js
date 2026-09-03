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
const { saveTransaction } = require("../src/storage/transactions");
const { canonicalCallbackMacInput } = require("../src/cardzone/mpi");
const { generateRsa2048KeyPair, signSha256WithRsa } = require("../src/crypto/rsa");

function extractHiddenField(html, fieldName) {
  const escapedName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`name=\"${escapedName}\" value=\"([^\"]*)\"`);
  const match = html.match(regex);
  return match ? match[1] : "";
}

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

test("stored wire purchase date is generated once and reused for MPIReq and hosted form", async () => {
  const txn = createTransaction({ merchantId: "863990035600270", amountMajor: 1, currency: "840" });
  const createdWireDate = txn.mpiPurchaseDate;
  expect(/^\d{14}$/.test(createdWireDate)).toBe(true);

  await runMkReq(txn.txnId);
  const built = buildMpiReq(txn.txnId, {
    cardNumber: "4111111111111111",
    expiry: "1228",
    cvv: "123"
  });

  expect(built.mpiPurchaseDate).toBe(createdWireDate);
  expect(built.mpiReq.wirePurchaseDate).toBe(createdWireDate);
  expect(built.mpiReq.fieldsSafe.MPI_PURCH_DATE).toBe(createdWireDate);

  const html = generateHostedFormHtml(txn.txnId);
  expect(extractHiddenField(html, "MPI_PURCH_DATE")).toBe(createdWireDate);

  const latest = getTxDetail(txn.txnId);
  expect(latest.mpiPurchaseDate).toBe(createdWireDate);
  expect(latest.diagnostics.formMacProof.formPurchaseDateEqualsStoredWireDate).toBe(true);
  expect(latest.diagnostics.formMacProof.hostedFormPurchaseDate).toBe(createdWireDate);
  expect(latest.diagnostics.formMacProof.mpiMacCanonicalPurchaseDate).toBe(
    latest.mpiReq.macPurchaseDate
  );
  expect(latest.mpiReq.macPurchaseDate).toBe(createdWireDate);
});

test("form purchase date remains unchanged after MAC generation", async () => {
  const txn = createTransaction({ merchantId: "863990035600270", amountMajor: 1, currency: "840" });
  await runMkReq(txn.txnId);
  const built = buildMpiReq(txn.txnId, {
    cardNumber: "4111111111111111",
    expiry: "1228",
    cvv: "123"
  });

  const initialWireDate = built.mpiReq.wirePurchaseDate;
  const firstHtml = generateHostedFormHtml(txn.txnId);
  const secondHtml = generateHostedFormHtml(txn.txnId);

  expect(extractHiddenField(firstHtml, "MPI_PURCH_DATE")).toBe(initialWireDate);
  expect(extractHiddenField(secondHtml, "MPI_PURCH_DATE")).toBe(initialWireDate);

  const latest = getTxDetail(txn.txnId);
  expect(latest.mpiReq.wirePurchaseDate).toBe(initialWireDate);
  expect(latest.mpiReq.macPurchaseDate).toBeDefined();
  expect(latest.diagnostics.formMacProof.formPurchaseDateEqualsStoredWireDate).toBe(true);
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
  expect(/^\d{1,20}$/.test(inq.inquiry.request.MPI_TRXN_ID)).toBe(true);
  expect(inq.inquiry.request.MPI_TRXN_ID.endsWith("_INQ")).toBe(false);
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

test("only enrolled UAT merchant IDs are accepted", () => {
  expect(() =>
    createTransaction({ merchantId: "863990030700270", amountMajor: 1, currency: "840" })
  ).toThrow("merchantId must be one of the enrolled UAT merchant IDs: 863990035600270, 863990026500270");

  const inr = createTransaction({ merchantId: "863990026500270", amountMajor: 1, currency: "356" });
  expect(inr.merchantId).toBe("863990026500270");
});

test("buildMpiReq aborts when mkReq pubkey differs from signing private key", async () => {
  const txn = createTransaction({ merchantId: "863990035600270", amountMajor: 1, currency: "840" });
  await runMkReq(txn.txnId);

  const badKeys = generateRsa2048KeyPair();
  const tampered = getTxDetail(txn.txnId);
  tampered.mkReq.request.pubKey = badKeys.publicKeyBase64Url;
  saveTransaction(tampered);

  expect(() =>
    buildMpiReq(txn.txnId, { cardNumber: "", expiry: "", cvv: "", responseType: "STRING" })
  ).toThrow(
    "Aborted: mkReq public key fingerprint does not match signing private-key-derived public key fingerprint."
  );
});

test("verified callback saves trusted final result and priority over inquiry", async () => {
  const txn = createTransaction({ merchantId: "863990035600270", amountMajor: 1, currency: "840" });
  await runMkReq(txn.txnId);

  // Generate valid callback signature
  const callbackFields = {
    MPI_MERC_ID: "863990035600270",
    MPI_TRXN_ID: txn.txnId,
    MPI_ERROR_CODE: "000",
    MPI_ERROR_DESC: "Approved",
    MPI_APPR_CODE: "APPR123",
    MPI_RRN: "RRN456",
    MPI_BIN: "411111",
    MPI_REFERRAL_CODE: "REF789",
    MPI_CARDHOLDER_INFO: "AUTH_OK"
  };

  const storedTxn = getTxDetail(txn.txnId);
  // In mock mode, cardzonePublicKey is generated. Let's sign using the mock private key for the mock cardzone key pair if available or simulate verified
  const input = canonicalCallbackMacInput(callbackFields);
  const keyPair = generateRsa2048KeyPair();
  storedTxn.mkReq.cardzonePublicKey = keyPair.publicKeyBase64Url;
  saveTransaction(storedTxn);

  const mac = signSha256WithRsa(keyPair.privateKeyPem, input);
  callbackFields.MPI_MAC = mac;

  const processed = processCallback(callbackFields);
  expect(processed.callbackReceived).toBe(true);
  expect(processed.callbackMacVerified).toBe(true);
  expect(processed.status).toBe("SUCCESS");
  expect(processed.finalResult.source).toBe("callback");
  expect(processed.finalResult.approvalCode).toBe("APPR123");
  expect(processed.finalResult.rrn).toBe("RRN456");
  expect(processed.finalResult.bin).toBe("411111");

  // Running inquiry afterwards should NOT overwrite the trusted callback finalResult
  const afterInq = await runInquiry(txn.txnId);
  expect(afterInq.finalResult.source).toBe("callback");
  expect(afterInq.status).toBe("SUCCESS");
});

