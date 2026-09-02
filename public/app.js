async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(data.error || text || `Request failed: ${response.status}`);
  }
  return data;
}

function setFlow(text) {
  const flow = document.getElementById("flow");
  if (flow) {
    flow.textContent = text;
  }
}

function value(id) {
  return document.getElementById(id).value;
}

async function loadConfig() {
  const cfg = await api("/api/config");
  document.getElementById("merchantPill").textContent = `Merchant ID: ${cfg.merchantId}`;
  document.getElementById("modePill").textContent = `Mode: ${cfg.mode}`;
  document.getElementById("merchantId").value = cfg.merchantId;
  setFlow(
    `Ready\nEnvironment: ${cfg.environment}\nMode: ${cfg.mode}\nmkReq: ${cfg.endpoints.mkReq}\nmercReq: ${cfg.endpoints.mercReq}`
  );
}

function validateMinimalFields() {
  const required = {
    amountMajor: value("amountMajor").trim(),
    currency: value("currency").trim()
  };

  if (!required.amountMajor || !required.currency) {
    throw new Error("Amount and currency are required.");
  }
  if (!Number.isFinite(Number(required.amountMajor)) || Number(required.amountMajor) <= 0) {
    throw new Error("Amount must be a positive number.");
  }
}

function bindButtons() {
  document.getElementById("loadUsd").onclick = () => {
    document.getElementById("currency").value = "840";
    document.getElementById("amountMajor").value = "1.00";
    document.getElementById("customerName").value = "UAT USD User";
    document.getElementById("customerEmail").value = "usd-uat@example.com";
  };
  document.getElementById("loadInr").onclick = () => {
    document.getElementById("currency").value = "356";
    document.getElementById("amountMajor").value = "10.00";
    document.getElementById("customerName").value = "UAT INR User";
    document.getElementById("customerEmail").value = "inr-uat@example.com";
  };
  document.getElementById("loadBtn").onclick = () => {
    document.getElementById("currency").value = "064";
    document.getElementById("amountMajor").value = "100.00";
    document.getElementById("customerName").value = "UAT Bhutan User";
    document.getElementById("customerEmail").value = "btn-uat@example.com";
  };

  const checkoutForm = document.getElementById("checkoutForm");
  checkoutForm.addEventListener("submit", (event) => {
    try {
      validateMinimalFields();
      document.getElementById("statusPill").textContent = "Status: Posting /api/initiate";
      setFlow("Submitting checkout form to /api/initiate...");
    } catch (error) {
      event.preventDefault();
      document.getElementById("statusPill").textContent = "Status: Validation Failed";
      setFlow(`Validation failed: ${error.message}`);
    }
  });
}

window.addEventListener("error", (e) => {
  document.getElementById("raw").textContent = `ERROR: ${e.message}`;
});

window.addEventListener("DOMContentLoaded", async () => {
  bindButtons();
  await loadConfig();
});
