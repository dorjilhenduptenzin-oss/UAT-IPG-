(function autoSubmitHostedForm() {
  const form = document.getElementById("mercReqForm");
  if (form) {
    const txnIdInput = form.querySelector("input[name='MPI_TRXN_ID']");
    const txnId = txnIdInput ? String(txnIdInput.value || "") : "";
    const purchDateInput = form.querySelector("input[name='MPI_PURCH_DATE']");
    const merchIdInput = form.querySelector("input[name='MPI_MERC_ID']");
    const purchDate = purchDateInput ? String(purchDateInput.value || "") : "";
    const merchId = merchIdInput ? String(merchIdInput.value || "") : "";

    // Temporary browser-side proof of literal values immediately before submit().
    try {
      console.info("UAT_BROWSER_FORM_SUBMIT", {
        FINAL_HTML_PURCHASE_ID: txnId,
        FINAL_HTML_MPI_PURCH_DATE: purchDate,
        FINAL_HTML_MERCHANT_ID: merchId
      });
    } catch {
      // Ignore console logging failures in strict browser contexts.
    }

    if (txnId) {
      // Best-effort signal that browser is about to submit form to Cardzone mercReq.
      const markUrl = `/api/transactions/${encodeURIComponent(txnId)}/hosted-form-submitted`;
      if (navigator.sendBeacon) {
        const payload = JSON.stringify({
          finalHtmlPurchaseId: txnId,
          finalHtmlMpiPurchDate: purchDate,
          finalHtmlMerchantId: merchId
        });
        navigator.sendBeacon(markUrl, new Blob([payload], { type: "application/json" }));
      } else {
        fetch(markUrl, {
          method: "POST",
          keepalive: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            finalHtmlPurchaseId: txnId,
            finalHtmlMpiPurchDate: purchDate,
            finalHtmlMerchantId: merchId
          })
        }).catch(() => {});
      }
    }
    form.submit();
  }
})();
