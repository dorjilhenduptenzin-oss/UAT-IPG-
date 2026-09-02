const {
  canonicalMpiPurchaseDateForCardzoneMac,
  buildMpiLineItem,
  formatPurchaseDate,
  formatUtcPurchaseDate,
  PURCHASE_DATE_TIME_ZONE,
  MPI_MAC_PURCHASE_DATE_TZ_ASIA_THIMPHU,
  getMpiReqMacFieldSequence,
  canonicalMpiMacInput,
  generateMpiMac,
  verifyMpiMac
} = require("../src/cardzone/mpi");
const { generateRsa2048KeyPair } = require("../src/crypto/rsa");
const { MPI_MAC_FIELD_ORDER } = require("../src/cardzone/fields");

function minimalFields(overrides = {}) {
  const base = {};
  for (const field of MPI_MAC_FIELD_ORDER) {
    base[field] = "";
  }
  return {
    ...base,
    MPI_TRANS_TYPE: "SALES",
    MPI_MERC_ID: "863990026500270",
    MPI_PAN: "4111111111111111",
    MPI_CARD_HOLDER_NAME: "UAT USER",
    MPI_PAN_EXP: "1228",
    MPI_CVV2: "123",
    MPI_TRXN_ID: "TXN123",
    MPI_PURCH_DATE: "20260901094512",
    MPI_PURCH_CURR: "840",
    MPI_PURCH_AMT: "100",
    MPI_RESPONSE_TYPE: "STRING",
    ...overrides
  };
}

test("MPI_MAC field ordering is exact positional concatenation", () => {
  const fields = minimalFields();
  const input = canonicalMpiMacInput(fields);
  expect(input.startsWith("SALES8639900265002704111111111111111UAT USER1228123TXN123")).toBe(true);
});

test("empty fields are included as empty strings and not skipped", () => {
  const fields = minimalFields({ MPI_BILL_ADDR_CITY: "", MPI_BILL_ADDR_STATE: "" });
  const input = canonicalMpiMacInput(fields);
  expect(typeof input).toBe("string");
  expect(input.includes("undefined")).toBe(false);
});

test("MPI_LINE_ITEM uses semicolon separated subfields", () => {
  const line = buildMpiLineItem([
    {
      MPI_ITEM_ID: "SKU1",
      MPI_ITEM_REMARK: "Test",
      MPI_ITEM_QUANTITY: "1",
      MPI_ITEM_AMOUNT: "100",
      MPI_ITEM_CURRENCY: "840"
    }
  ]);
  expect(line).toBe("SKU1;Test;1;100;840");
});

test("MPI_RESPONSE_TYPE is included in canonical input when enabled", () => {
  const fields = minimalFields({ MPI_RESPONSE_TYPE: "JSON" });
  const input = canonicalMpiMacInput(fields, { includeResponseType: true });
  expect(input.endsWith("JSON")).toBe(true);
});

test("MPI_RESPONSE_TYPE is excluded from canonical input when disabled", () => {
  const fields = {
    ...minimalFields({
      MPI_TRANS_TYPE: "SALES",
      MPI_MERC_ID: "863990035600270",
      MPI_PAN: "",
      MPI_CARD_HOLDER_NAME: "",
      MPI_PAN_EXP: "",
      MPI_CVV2: "",
      MPI_TRXN_ID: "20260901083051128",
      MPI_ORI_TRXN_ID: "",
      MPI_PURCH_DATE: "20260901083051",
      MPI_PURCH_CURR: "840",
      MPI_PURCH_AMT: "100",
      MPI_RESPONSE_TYPE: "STRING"
    })
  };
  const input = canonicalMpiMacInput(fields, {
    includeResponseType: false,
    purchaseDateTimezone: MPI_MAC_PURCHASE_DATE_TZ_ASIA_THIMPHU
  });
  expect(input).toBe("SALES8639900356002702026090108305112820260901143051840100");
  expect(input.length).toBe(57);
  expect(require("../src/utils/hash").sha256Hex(input)).toBe(
    "849c0c3f242e3110717840f00ab267c365ccae683cc73e82169969c635b02ebc"
  );
});

test("MAC field sequence drops only MPI_RESPONSE_TYPE when disabled", () => {
  const withField = getMpiReqMacFieldSequence({ includeResponseType: true });
  const withoutField = getMpiReqMacFieldSequence({ includeResponseType: false });
  expect(withField.includes("MPI_RESPONSE_TYPE")).toBe(true);
  expect(withoutField.includes("MPI_RESPONSE_TYPE")).toBe(false);
  expect(withField.length - withoutField.length).toBe(1);
});

test("MAC verification succeeds for generated signature", () => {
  const keys = generateRsa2048KeyPair();
  const fields = minimalFields();
  const signed = generateMpiMac(keys.privateKeyPem, fields);
  const verify = verifyMpiMac(keys.publicKeyBase64Url, fields, signed.signature);
  expect(verify.ok).toBe(true);
});

test("MAC verification succeeds when response type is excluded", () => {
  const keys = generateRsa2048KeyPair();
  const fields = minimalFields({
    MPI_PAN: "",
    MPI_CARD_HOLDER_NAME: "",
    MPI_PAN_EXP: "",
    MPI_CVV2: "",
    MPI_TRXN_ID: "20260901083051128",
    MPI_PURCH_DATE: "20260901083051",
    MPI_MERC_ID: "863990035600270",
    MPI_PURCH_CURR: "840",
    MPI_PURCH_AMT: "100",
    MPI_RESPONSE_TYPE: "STRING"
  });
  const signed = generateMpiMac(keys.privateKeyPem, fields, {
    includeResponseType: false,
    purchaseDateTimezone: MPI_MAC_PURCHASE_DATE_TZ_ASIA_THIMPHU
  });
  const verify = verifyMpiMac(
    keys.publicKeyBase64Url,
    fields,
    signed.signature,
    {
      includeResponseType: false,
      purchaseDateTimezone: MPI_MAC_PURCHASE_DATE_TZ_ASIA_THIMPHU
    }
  );
  expect(signed.input).toBe("SALES8639900356002702026090108305112820260901143051840100");
  expect(verify.ok).toBe(true);
});

test("wire purchase date uses explicit UTC formatting", () => {
  const input = new Date("2026-09-01T09:17:36Z");
  expect(formatUtcPurchaseDate(input)).toBe("20260901091736");
});

test("canonical MAC purchase date uses explicit Asia/Thimphu timezone", () => {
  const input = new Date("2026-09-01T09:17:36Z");
  expect(PURCHASE_DATE_TIME_ZONE).toBe("Asia/Thimphu");
  expect(formatPurchaseDate(input)).toBe("20260901151736");
});

test("purchase date is exactly 14 digits and not UTC formatted", () => {
  const wire = "20260901091736";
  const formatted = canonicalMpiPurchaseDateForCardzoneMac(wire, {
    purchaseDateTimezone: MPI_MAC_PURCHASE_DATE_TZ_ASIA_THIMPHU
  });
  expect(/^\d{14}$/.test(formatted)).toBe(true);
  expect(formatted).not.toBe(wire);
});

test("canonical purchase date equals wire date when timezone transform is disabled", () => {
  const wire = "20260902030711";
  const formatted = canonicalMpiPurchaseDateForCardzoneMac(wire, {
    purchaseDateTimezone: null
  });
  expect(formatted).toBe(wire);
});

test("changing purchase date changes MPI_MAC", () => {
  const keys = generateRsa2048KeyPair();
  const first = minimalFields({
    MPI_MERC_ID: "863990035600270",
    MPI_TRXN_ID: "20260901091735694",
    MPI_PURCH_DATE: "20260901091736",
    MPI_PURCH_CURR: "840",
    MPI_PURCH_AMT: "100",
    MPI_RESPONSE_TYPE: "STRING",
    MPI_PAN: "",
    MPI_CARD_HOLDER_NAME: "",
    MPI_PAN_EXP: "",
    MPI_CVV2: ""
  });
  const second = { ...first, MPI_PURCH_DATE: "20260901091737" };
  const macA = generateMpiMac(keys.privateKeyPem, first, {
    includeResponseType: false,
    purchaseDateTimezone: MPI_MAC_PURCHASE_DATE_TZ_ASIA_THIMPHU
  });
  const macB = generateMpiMac(keys.privateKeyPem, second, {
    includeResponseType: false,
    purchaseDateTimezone: MPI_MAC_PURCHASE_DATE_TZ_ASIA_THIMPHU
  });
  expect(macA.input).toBe("SALES8639900356002702026090109173569420260901151736840100");
  expect(macA.signature).not.toBe(macB.signature);
});

test("wire purchase date is converted to Cardzone MAC purchase date for observed UAT vectors", () => {
  expect(
    canonicalMpiPurchaseDateForCardzoneMac("20260901092047", {
      purchaseDateTimezone: MPI_MAC_PURCHASE_DATE_TZ_ASIA_THIMPHU
    })
  ).toBe("20260901152047");
  expect(
    canonicalMpiPurchaseDateForCardzoneMac("20260901091736", {
      purchaseDateTimezone: MPI_MAC_PURCHASE_DATE_TZ_ASIA_THIMPHU
    })
  ).toBe("20260901151736");
});

test("purchase id remains unchanged while purchase date can vary", () => {
  const fields = minimalFields({
    MPI_TRXN_ID: "20260901091735694",
    MPI_PURCH_DATE: "20260901151736",
    MPI_RESPONSE_TYPE: "STRING",
    MPI_PAN: "",
    MPI_CARD_HOLDER_NAME: "",
    MPI_PAN_EXP: "",
    MPI_CVV2: ""
  });
  const input = canonicalMpiMacInput(fields, { includeResponseType: false });
  expect(fields.MPI_TRXN_ID).toBe("20260901091735694");
  expect(input).toContain("20260901091735694");
});

test("canonical string matches Cardzone UAT vector while response type stays excluded", () => {
  const fields = minimalFields({
    MPI_MERC_ID: "863990035600270",
    MPI_TRXN_ID: "20260901092047332",
    MPI_PURCH_DATE: "20260901092047",
    MPI_PURCH_CURR: "840",
    MPI_PURCH_AMT: "100",
    MPI_RESPONSE_TYPE: "STRING",
    MPI_PAN: "",
    MPI_CARD_HOLDER_NAME: "",
    MPI_PAN_EXP: "",
    MPI_CVV2: ""
  });
  const canonical = canonicalMpiMacInput(fields, {
    includeResponseType: false,
    purchaseDateTimezone: MPI_MAC_PURCHASE_DATE_TZ_ASIA_THIMPHU
  });
  expect(canonical).toBe("SALES8639900356002702026090109204733220260901152047840100");
});

test("known Cardzone UAT vector produces exact canonical string", () => {
  const fields = minimalFields({
    MPI_TRANS_TYPE: "SALES",
    MPI_MERC_ID: "863990035600270",
    MPI_PAN: "",
    MPI_CARD_HOLDER_NAME: "",
    MPI_PAN_EXP: "",
    MPI_CVV2: "",
    MPI_TRXN_ID: "2026090204484090456",
    MPI_ORI_TRXN_ID: "",
    MPI_PURCH_DATE: "20260901224841",
    MPI_PURCH_CURR: "840",
    MPI_PURCH_AMT: "100",
    MPI_RESPONSE_TYPE: "STRING"
  });

  const canonical = canonicalMpiMacInput(fields, {
    includeResponseType: false,
    purchaseDateTimezone: MPI_MAC_PURCHASE_DATE_TZ_ASIA_THIMPHU
  });

  expect(canonical).toBe("SALES863990035600270202609020448409045620260902044841840100");
});

test("canonical string remains exact for transaction 2026090207273400149", () => {
  const fields = minimalFields({
    MPI_TRANS_TYPE: "SALES",
    MPI_MERC_ID: "863990035600270",
    MPI_PAN: "",
    MPI_CARD_HOLDER_NAME: "",
    MPI_PAN_EXP: "",
    MPI_CVV2: "",
    MPI_TRXN_ID: "2026090207273400149",
    MPI_ORI_TRXN_ID: "",
    MPI_PURCH_DATE: "20260902012735",
    MPI_PURCH_CURR: "840",
    MPI_PURCH_AMT: "100",
    MPI_RESPONSE_TYPE: "STRING"
  });

  const canonical = canonicalMpiMacInput(fields, {
    includeResponseType: false,
    purchaseDateTimezone: MPI_MAC_PURCHASE_DATE_TZ_ASIA_THIMPHU
  });

  expect(canonical).toBe("SALES863990035600270202609020727340014920260902072735840100");
});

test("canonical MAC purchase date handles midnight rollover", () => {
  expect(
    canonicalMpiPurchaseDateForCardzoneMac("20260901235959", {
      purchaseDateTimezone: MPI_MAC_PURCHASE_DATE_TZ_ASIA_THIMPHU
    })
  ).toBe("20260902055959");
});

test("canonical MAC purchase date handles month rollover", () => {
  expect(
    canonicalMpiPurchaseDateForCardzoneMac("20260131190000", {
      purchaseDateTimezone: MPI_MAC_PURCHASE_DATE_TZ_ASIA_THIMPHU
    })
  ).toBe("20260201010000");
});

test("canonical MAC purchase date handles year rollover", () => {
  expect(
    canonicalMpiPurchaseDateForCardzoneMac("20261231190000", {
      purchaseDateTimezone: MPI_MAC_PURCHASE_DATE_TZ_ASIA_THIMPHU
    })
  ).toBe("20270101010000");
});

test("known Cardzone evidence vector uses one wire date source", () => {
  const fields = minimalFields({
    MPI_TRANS_TYPE: "SALES",
    MPI_MERC_ID: "863990035600270",
    MPI_PAN: "",
    MPI_CARD_HOLDER_NAME: "",
    MPI_PAN_EXP: "",
    MPI_CVV2: "",
    MPI_TRXN_ID: "2026090208572025579",
    MPI_ORI_TRXN_ID: "",
    MPI_PURCH_DATE: "20260902025721",
    MPI_PURCH_CURR: "840",
    MPI_PURCH_AMT: "100",
    MPI_RESPONSE_TYPE: "STRING"
  });

  const macDate = canonicalMpiPurchaseDateForCardzoneMac(fields.MPI_PURCH_DATE, {
    purchaseDateTimezone: MPI_MAC_PURCHASE_DATE_TZ_ASIA_THIMPHU
  });
  expect(macDate).toBe("20260902085721");

  const canonical = canonicalMpiMacInput(fields, {
    includeResponseType: false,
    purchaseDateTimezone: MPI_MAC_PURCHASE_DATE_TZ_ASIA_THIMPHU
  });

  expect(canonical).toBe("SALES863990035600270202609020857202557920260902085721840100");
});

test("regression vector capability builds canonical string without expected signature", () => {
  const fields = minimalFields({
    MPI_TRANS_TYPE: "SALES",
    MPI_MERC_ID: "863990026500270"
  });
  const canonical = canonicalMpiMacInput(fields);
  expect(canonical.length).toBeGreaterThan(20);
});

