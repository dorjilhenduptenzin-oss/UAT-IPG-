function maskPan(pan) {
  if (!pan) return "";
  const clean = String(pan).replace(/\s+/g, "");
  if (clean.length <= 4) return "*".repeat(clean.length);
  return `${"*".repeat(Math.max(0, clean.length - 4))}${clean.slice(-4)}`;
}

function maskValue(name, value) {
  if (value === undefined || value === null) return "";
  const key = String(name || "").toUpperCase();
  if (key.includes("CVV") || key === "MPI_CVV2") {
    return "***";
  }
  if (key.includes("PAN")) {
    return maskPan(value);
  }
  if (key.includes("PRIVATE") && key.includes("KEY")) {
    return "[REDACTED_PRIVATE_KEY]";
  }
  return value;
}

module.exports = {
  maskPan,
  maskValue
};
