(function autoSubmitHostedForm() {
  const form = document.getElementById("mercReqForm");
  if (form) {
    const txnIdInput = form.querySelector("input[name='MPI_TRXN_ID']");
    const txnId = txnIdInput ? String(txnIdInput.value || "") : "";
    if (txnId) {
      // Best-effort signal that browser is about to submit form to Cardzone mercReq.
      const markUrl = `/api/transactions/${encodeURIComponent(txnId)}/hosted-form-submitted`;
      if (navigator.sendBeacon) {
        navigator.sendBeacon(markUrl, new Blob([], { type: "application/octet-stream" }));
      } else {
        fetch(markUrl, { method: "POST", keepalive: true }).catch(() => {});
      }
    }
    form.submit();
  }
})();
