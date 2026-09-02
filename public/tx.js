function qp(name) {
  return new URLSearchParams(window.location.search).get(name);
}

async function load() {
  const txnId = qp("txnId");
  if (!txnId) {
    document.getElementById("meta").textContent = "Missing txnId";
    return;
  }

  const response = await fetch(`/api/tx/${encodeURIComponent(txnId)}`);
  const data = await response.json();
  if (!response.ok) {
    document.getElementById("meta").textContent = data.error || "Failed to load";
    return;
  }

  document.getElementById("meta").textContent = `Transaction ID: ${data.txnId} | Status: ${data.status}`;
  const items = [
    ["Transaction Created", data.timeline.created],
    ["RSA Key Generated/Loaded", data.timeline.key],
    ["mkReq Sent", data.timeline.mkreqSent],
    ["mkReq Response", data.timeline.mkreqResponse],
    ["MPIReq Created", data.timeline.mpireqCreated || data.timeline.mpiBuilt],
    ["MPI_MAC Generated", data.timeline.macGenerated],
    ["Hosted Form Generated", data.timeline.hostedFormGenerated],
    ["Hosted Form Submitted", data.timeline.hostedFormSubmitted],
    ["Cardzone Response Received", data.timeline.cardzoneResponseReceived],
    ["Cardzone Card Form Present", data.timeline.cardzoneCardFormPresent],
    ["Cardzone Redirect", data.timeline.cardzoneRedirect],
    ["Callback Received", data.timeline.callbackReceived],
    ["Callback MAC Verified", data.timeline.callbackMacVerified],
    ["Inquiry Request", data.timeline.inquiryRequest],
    ["Inquiry Result", data.timeline.inquiryResult],
    ["Inquiry", data.timeline.inquiry],
    ["Final Result", data.timeline.final]
  ];

  document.getElementById("timeline").innerHTML = items
    .map(([n, s]) => `<li>${n}: <strong>${s}</strong></li>`)
    .join("");
  document.getElementById("raw").textContent = JSON.stringify(data, null, 2);
}

load();
