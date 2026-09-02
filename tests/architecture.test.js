const request = require("supertest");

process.env.MODE = "MOCK";

const app = require("../src/app");
const vercelEntry = require("../api/index");
const vercelCatchAll = require("../api/[...path]");

test("Vercel entry point exports the same Express app instance", () => {
  expect(vercelEntry).toBe(app);
  expect(vercelCatchAll).toBe(vercelEntry);
});

test("Vercel entry point serves the same route registrations", async () => {
  const healthRes = await request(vercelEntry).get("/health");
  expect(healthRes.status).toBe(200);
  expect(healthRes.body.environment).toBe("UAT");

  const configRes = await request(vercelEntry).get("/api/config");
  expect(configRes.status).toBe(200);
  expect(configRes.body.environment).toBe("UAT");
  expect(configRes.body.endpoints.mkReq).toContain("uatczsecure.bob.bt");
});
