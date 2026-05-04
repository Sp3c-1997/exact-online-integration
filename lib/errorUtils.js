/**
 * Safe message for any thrown value (Error, string, or unknown).
 * @param {unknown} err
 * @returns {string}
 */
function errMessage(err) {
  if (err == null) {
    return "Unknown error";
  }
  if (typeof err === "string") {
    return err;
  }
  if (err instanceof Error) {
    return err.message || "Error";
  }
  if (typeof err === "object" && typeof err.message === "string") {
    return err.message;
  }
  try {
    return String(err);
  } catch {
    return "Error";
  }
}

/**
 * Small helper to create an Error with stable metadata.
 * @param {string} message
 * @param {{ code?: string, httpStatus?: number, exactStatus?: number, cause?: unknown }} [meta]
 * @returns {Error & { code?: string, httpStatus?: number, exactStatus?: number, cause?: unknown }}
 */
function appError(message, meta = {}) {
  const err = new Error(message);
  if (meta.code) err.code = meta.code;
  if (Number.isInteger(meta.httpStatus)) err.httpStatus = meta.httpStatus;
  // From meta (new Error() has no exactStatus until we assign it)
  if (Number.isInteger(meta.exactStatus)) err.exactStatus = meta.exactStatus;
  if (meta.cause !== undefined) err.cause = meta.cause;
  return err;
}

/**
 * Map Exact HTTP status to a client-facing API status.
 * @param {number} exactStatus
 * @returns {number}
 */
function clientStatusForExact(exactStatus) {
  if (exactStatus === 401) return 401;
  if (exactStatus === 403) return 403;
  if (exactStatus === 404) return 404;
  if (exactStatus === 429) return 429;
  if (exactStatus >= 500) return 502;
  if (exactStatus >= 400) return 400;
  return 500;
}

/**
 * Suggested status for invoice / integration routes when an Error has no httpStatus.
 * @param {unknown} err
 * @param {string} message
 * @returns {number}
 */
function statusForIntegrationError(err, message) {
  if (err && typeof err === "object" && Number.isInteger(err.httpStatus)) {
    return err.httpStatus;
  }

  // Prefer stable error codes over message matching.
  const code = err && typeof err === "object" ? err.code : undefined;
  if (typeof code === "string") {
    const byCode = {
      EXACT_TIMEOUT: 503,
      EXACT_FETCH_FAILED: 503,
      EXACT_MAX_RETRIES: 503,
      EXACT_INVALID_JSON: 502,
      EXACT_UNAUTHORIZED: 401,
      OAUTH_NO_SESSION: 401,
      OAUTH_MISSING_DIVISION: 401,
      OAUTH_NO_REFRESH_TOKEN: 401,
      OAUTH_TOKEN_REFRESH_FAILED: 401,
      OAUTH_NO_ACCESS_TOKEN: 401
    };
    if (code && code in byCode) {
      return byCode[code];
    }
  }

  // Legacy fallback for older throw-sites not yet tagged.
  if (/Exact request timed out|timed out after/i.test(message)) return 503;
  if (/No OAuth session|complete OAuth|OAuth session missing division|Unauthorized from Exact|No access token|token refresh failed/i.test(message)) return 401;

  return 500;
}

module.exports = {
  errMessage,
  appError,
  clientStatusForExact,
  statusForIntegrationError
};
