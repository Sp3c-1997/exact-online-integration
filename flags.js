function isTruthy(value) {
  if (value == null) {
    return false;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

const EXACT_DEBUG_LOGS = isTruthy(process.env.EXACT_DEBUG_LOGS);

module.exports = {
  EXACT_DEBUG_LOGS,
  isTruthy
};
