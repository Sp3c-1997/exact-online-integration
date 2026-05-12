const { getOAuthSession } = require("../db/tokenStore");
const { ensureValidAccessToken, refreshAccessToken, getExactBaseUrl } = require("./oauthService");
const logger = require("../lib/logger");
const { clientStatusForExact, appError } = require("../lib/errorUtils");
const { isExactMockEnabled, getMockJsonObject } = require("./exactMock");

const DEFAULT_EXACT_FETCH_TIMEOUT_MS = 10_000;

/** Max attempts for retriable failures (network, timeout, 5xx, or auth recovery). */
const EXACT_MAX_ATTEMPTS = 3;

/**
 * @param {Error & { code?: string, exactStatus?: number }} err
 * @returns {boolean}
 */
function isRetriableExactError(err) {
  if (!err || typeof err !== "object" || !err.code) {
    return false;
  }
  if (err.code === "EXACT_TIMEOUT" || err.code === "EXACT_FETCH_FAILED") {
    return true;
  }
  if (err.code === "EXACT_HTTP_ERROR" && Number.isInteger(err.exactStatus) && err.exactStatus >= 500) {
    return true;
  }
  return false;
}

/**
 * Wraps a single Exact JSON GET with limited retries. Does not change success paths.
 * @param {() => Promise<T>} fn
 * @param {{ pathHint: string }} ctx
 * @template T
 * @returns {Promise<T>}
 */
async function withExactApiRetry(fn, ctx) {
  const { pathHint } = ctx;

  for (let attempt = 1; attempt <= EXACT_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const e = err && typeof err === "object" ? err : null;
      const code = e && e.code;
      // Always log both message and code when present
      logger.warn("Exact API attempt failed", {
        attempt,
        maxAttempts: EXACT_MAX_ATTEMPTS,
        pathHint: pathHint.slice(0, 200),
        message: err instanceof Error ? err.message : String(err),
        code: code != null ? code : undefined
      });

      // 401 after `getJson` already refreshed: try one more token refresh, then re-run
      if (code === "EXACT_UNAUTHORIZED" && attempt < EXACT_MAX_ATTEMPTS) {
        try {
          await refreshAccessToken();
        } catch (refreshErr) {
          const r = refreshErr && typeof refreshErr === "object" && refreshErr.code;
          logger.error("Exact token refresh in retry failed", {
            message: refreshErr instanceof Error ? refreshErr.message : String(refreshErr),
            code: r != null ? r : undefined
          });
          throw refreshErr;
        }
        continue;
      }

      if (isRetriableExactError(err) && attempt < EXACT_MAX_ATTEMPTS) {
        continue;
      }

      if (attempt === EXACT_MAX_ATTEMPTS && isRetriableExactError(err)) {
        throw buildExactMaxRetriesError(err, pathHint);
      }
      if (attempt === EXACT_MAX_ATTEMPTS && code === "EXACT_UNAUTHORIZED") {
        throw buildExactMaxRetriesError(err, pathHint);
      }

      throw err;
    }
  }
}

/**
 * @param {Error & { code?: string, exactStatus?: number }} [cause]
 * @param {string} pathHint
 */
function buildExactMaxRetriesError(cause, pathHint) {
  const lastMsg = cause && cause.message != null ? String(cause.message) : "Unknown error";
  const out = appError(
    `Exact API failed after ${EXACT_MAX_ATTEMPTS} attempts: ${pathHint.slice(0, 120)} — ${lastMsg}`,
    { code: "EXACT_MAX_RETRIES", httpStatus: 503, cause }
  );
  if (cause && typeof cause === "object" && Number.isInteger(cause.exactStatus)) {
    out.exactStatus = cause.exactStatus;
  }
  return out;
}

/**
 * @param {string} url
 * @param {RequestInit} [options]
 * @param {number} [timeoutMs]
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_EXACT_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error && (error.name === "AbortError" || error.code === 20)) {
      logger.error("Exact request timed out", {
        code: "EXACT_TIMEOUT",
        message: error && error.message,
        timeoutMs,
        url: String(url).slice(0, 200)
      });
      throw appError(`Exact request timed out after ${timeoutMs}ms`, {
        code: "EXACT_TIMEOUT",
        httpStatus: 503
      });
    }
    logger.error("Exact fetch failed", {
      code: "EXACT_FETCH_FAILED",
      message: error && error.message,
      url: String(url).slice(0, 200)
    });
    throw appError(`Exact request failed: ${error && error.message ? error.message : "network error"}`, {
      code: "EXACT_FETCH_FAILED",
      httpStatus: 503,
      cause: error
    });
  } finally {
    clearTimeout(id);
  }
}

/**
 * Build default headers for Exact API calls. Ensures a valid access token first.
 */
async function getAuthHeaders() {
  const accessToken = await ensureValidAccessToken();
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json"
  };
}

async function buildRequestUrl(pathOrQuery) {
  const raw = String(pathOrQuery).trim();

  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return raw;
  }

  if (raw.startsWith("/api/v1/")) {
    return `${getExactBaseUrl().replace(/\/$/, "")}${raw}`;
  }

  const session = await getOAuthSession();
  if (!session?.division) {
    throw appError("Exact OAuth session missing division. Did you complete OAuth?", {
      code: "OAUTH_MISSING_DIVISION",
      httpStatus: 401
    });
  }

  const path = raw.replace(/^\//, "");
  return `${getExactBaseUrl()}/api/v1/${session.division}/${path}`;
}

/**
 * GET a resource. Accepts:
 * - entity path: `salesinvoice/SalesInvoices?$top=1` (uses session division)
 * - normalized __next: `/api/v1/{division}/salesinvoice/...?...`
 * - full Exact URL: `https://start.exactonline.nl/api/v1/...`
 * Refreshes the token if needed; on 401, refreshes once and retries.
 */
async function getJson(pathWithQuery) {
  const url = await buildRequestUrl(pathWithQuery);
  logger.debug("Exact GET", { path: String(pathWithQuery).slice(0, 200) });

  const fetchOnce = async () =>
    fetchWithTimeout(url, { headers: await getAuthHeaders() }, DEFAULT_EXACT_FETCH_TIMEOUT_MS);

  let response = await fetchOnce();
  if (response.status === 401) {
    logger.warn("Exact 401, refreshing access token and retrying");
    await refreshAccessToken();
    response = await fetchOnce();
  }

  if (response.status === 401) {
    logger.error("Exact still 401 after token refresh", {
      code: "EXACT_UNAUTHORIZED",
      path: String(pathWithQuery).slice(0, 120)
    });
    throw appError("Unauthorized from Exact even after token refresh", {
      code: "EXACT_UNAUTHORIZED",
      httpStatus: 401,
      exactStatus: 401
    });
  }

  if (!response.ok) {
    // Non-OK: status here; per-response code is set when parsing fails in getJsonObjectOnce
    logger.warn("Exact non-OK response", {
      status: response.status,
      path: String(pathWithQuery).slice(0, 120),
      code: response.status >= 500 ? "EXACT_SERVER_ERROR" : "EXACT_CLIENT_ERROR"
    });
  }

  return response;
}

/**
 * Single attempt: GET and parse JSON; throws on non-OK.
 * @param {string} pathWithQuery
 * @returns {Promise<object>}
 */
async function getJsonObjectOnce(pathWithQuery) {
  const response = await getJson(pathWithQuery);
  const text = await response.text();
  if (!response.ok) {
    const snippet = text.slice(0, 500);
    logger.error("Exact API error body", {
      status: response.status,
      code: "EXACT_HTTP_ERROR",
      snippet: text.slice(0, 300)
    });
    throw appError(`Exact API ${response.status}: ${snippet}`, {
      code: "EXACT_HTTP_ERROR",
      exactStatus: response.status,
      httpStatus: clientStatusForExact(response.status)
    });
  }
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (parseErr) {
    const msg = parseErr && parseErr instanceof Error ? parseErr.message : String(parseErr);
    logger.error("Exact response is not valid JSON", {
      code: "EXACT_INVALID_JSON",
      message: msg,
      preview: text.slice(0, 200)
    });
    throw appError("Exact response was not valid JSON", {
      code: "EXACT_INVALID_JSON",
      httpStatus: 502,
      cause: parseErr
    });
  }
}

/**
 * Same as getJsonObjectOnce, with withExactApiRetry (max 3).
 * When `EXACT_MOCK=1`, reads from `data/exact-mock/*.json` instead of the live API.
 * @param {string} pathWithQuery
 * @returns {Promise<object>}
 */
async function getJsonObjectWithRetry(pathWithQuery) {
  const pathHint = String(pathWithQuery).trim();
  if (isExactMockEnabled()) {
    return getMockJsonObject(pathHint);
  }
  return withExactApiRetry(() => getJsonObjectOnce(pathHint), { pathHint });
}

module.exports = {
  getAuthHeaders,
  getJson,
  getJsonObject: getJsonObjectWithRetry,
  getJsonObjectWithRetry,
  buildRequestUrl,
  fetchWithTimeout
};
