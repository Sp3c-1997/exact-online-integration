const querystring = require("querystring");
const {
  saveOAuthSession,
  getOAuthSession,
  clearOAuthSession,
  isAccessTokenExpired,
  shouldRefreshAccessToken
} = require("../db/tokenStore");
const logger = require("../lib/logger");
const { appError } = require("../lib/errorUtils");
const { EXACT_DEBUG_LOGS } = require("../lib/flags");

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function buildExactAuthUrl() {
  const clientId = getRequiredEnv("CLIENT_ID");
  const redirectUri = getRequiredEnv("REDIRECT_URI");

  return `https://start.exactonline.nl/api/oauth2/auth?${querystring.stringify({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    force_login: 1
  })}`;
}

function parseOauthCallback(query) {
  const { code, error, error_description: errorDescription } = query;

  if (error) {
    return {
      ok: false,
      statusCode: 400,
      body: {
        error,
        message: errorDescription || "Authorization failed"
      }
    };
  }

  if (!code) {
    return {
      ok: false,
      statusCode: 400,
      body: {
        error: "missing_code",
        message: "Missing authorization code in callback query string."
      }
    };
  }

  return {
    ok: true,
    statusCode: 200,
    body: {
      message: "Authorization code received.",
      code
    }
  };
}

function getExactBaseUrl() {
  return process.env.EXACT_BASE_URL || "https://start.exactonline.nl";
}

async function exchangeCodeForTokens(code) {
  const clientId = getRequiredEnv("CLIENT_ID");
  const clientSecret = getRequiredEnv("CLIENT_SECRET");
  const redirectUri = getRequiredEnv("REDIRECT_URI");

  const tokenUrl = `${getExactBaseUrl()}/api/oauth2/token`;
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: querystring.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    const message = payload.error_description || payload.error || "Token exchange failed";
    logger.error("Exact OAuth token exchange failed", { status: response.status, error: payload.error });
    throw appError(message, {
      code: "OAUTH_TOKEN_EXCHANGE_FAILED",
      httpStatus: response.status === 401 || response.status === 403 ? 401 : 502,
      exactStatus: response.status
    });
  }

  return payload;
}

/**
 * Exchanges the stored refresh token for a new access (and usually refresh) token.
 * Persists the updated session via Supabase (tokenStore).
 */
async function refreshAccessToken() {
  const session = await getOAuthSession();
  if (!session?.refresh_token) {
    throw appError("No refresh token in session. Re-authorize via OAuth.", {
      code: "OAUTH_NO_REFRESH_TOKEN",
      httpStatus: 401
    });
  }

  const clientId = getRequiredEnv("CLIENT_ID");
  const clientSecret = getRequiredEnv("CLIENT_SECRET");

  const tokenUrl = `${getExactBaseUrl()}/api/oauth2/token`;
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: querystring.stringify({
      grant_type: "refresh_token",
      refresh_token: session.refresh_token,
      client_id: clientId,
      client_secret: clientSecret
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    const message = payload.error_description || payload.error || "Token refresh failed";
    logger.error("Exact OAuth token refresh failed", { status: response.status, error: payload.error });
    throw appError(message, {
      code: "OAUTH_TOKEN_REFRESH_FAILED",
      httpStatus: response.status === 401 || response.status === 403 ? 401 : 502,
      exactStatus: response.status
    });
  }

  logger.info("Exact access token refreshed");

  const expiresInSeconds = Number(payload.expires_in || 0);
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  const refreshToken = payload.refresh_token || session.refresh_token;

  return saveOAuthSession({
    access_token: payload.access_token,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    division: session.division
  });
}

/**
 * Returns a valid access token for Exact API calls. Refreshes if expired
 * or within the default buffer of expiry. Call this before any authenticated request.
 */
async function ensureValidAccessToken() {
  const session = await getOAuthSession();
  if (!session) {
    throw appError("No OAuth session. Complete OAuth flow first.", {
      code: "OAUTH_NO_SESSION",
      httpStatus: 401
    });
  }

  if (await shouldRefreshAccessToken()) {
    await refreshAccessToken();
  }

  const updated = await getOAuthSession();
  if (!updated?.access_token) {
    throw appError("No access token available after refresh.", {
      code: "OAUTH_NO_ACCESS_TOKEN",
      httpStatus: 401
    });
  }

  return updated.access_token;
}

/**
 * Reads the user's current division from Exact (OAuth context).
 * @see Exact Online REST: GET ../api/v1/current/Me (field CurrentDivision)
 */
async function fetchCurrentDivision(accessToken) {
  const url = `${getExactBaseUrl()}/api/v1/current/Me?$select=CurrentDivision`;
  if (EXACT_DEBUG_LOGS) {
    logger.debug("Exact current/Me request", { url });
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json"
    }
  });

  const text = await response.text();
  if (!response.ok) {
    logger.error("Exact current/Me failed", {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      snippet: text.slice(0, 400)
    });
    throw appError(`Exact current/Me failed: ${response.status}: ${text.slice(0, 200)}`, {
      code: "EXACT_ME_FAILED",
      httpStatus: response.status >= 500 ? 502 : 400,
      exactStatus: response.status
    });
  }

  let data;
  try {
    data = JSON.parse(text);
    if (EXACT_DEBUG_LOGS) {
      logger.debug("Exact current/Me raw parsed response", { data });
    }
  } catch (e) {
    logger.error("Exact current/Me returned non-JSON", { preview: text.slice(0, 200) });
    throw appError("Exact current/Me returned invalid JSON", {
      code: "EXACT_ME_INVALID_JSON",
      httpStatus: 502
    });
  }

  const division =
    data && data.d != null
      ? (data.d.CurrentDivision != null ? data.d.CurrentDivision : data.d.results && data.d.results[0] && data.d.results[0].CurrentDivision)
      : undefined;

  if (EXACT_DEBUG_LOGS) {
    logger.debug("Exact current/Me extracted division candidates", {
      from_d_CurrentDivision: data && data.d ? data.d.CurrentDivision : undefined,
      from_d_results_0_CurrentDivision:
        data && data.d && Array.isArray(data.d.results) && data.d.results[0]
          ? data.d.results[0].CurrentDivision
          : undefined,
      final_division: division
    });
  }

  if (division == null || division === "") {
    logger.error("Exact current/Me missing CurrentDivision", {
      preview: text.slice(0, 400),
      data
    });
    throw appError("Exact current/Me did not return CurrentDivision", {
      code: "EXACT_NO_CURRENT_DIVISION",
      httpStatus: 502
    });
  }

  logger.info("Using Exact division from current/Me", { division });

  return String(division);
}

async function upsertOAuthSession(payload) {
  const { access_token, refresh_token, expires_at, division } = payload;

  if (!access_token || !refresh_token || !expires_at || !division) {
    const missing = [];
    if (!access_token) missing.push("access_token");
    if (!refresh_token) missing.push("refresh_token");
    if (!expires_at) missing.push("expires_at");
    if (!division) missing.push("division");
    throw new Error(`Missing required session field(s): ${missing.join(", ")}`);
  }

  return saveOAuthSession({ access_token, refresh_token, expires_at, division });
}

async function handleOauthCallback(query) {
  const parsed = parseOauthCallback(query);
  if (!parsed.ok) {
    return parsed;
  }

  const tokens = await exchangeCodeForTokens(parsed.body.code);

  if (EXACT_DEBUG_LOGS) {
    logger.debug("OAuth token exchange debug", {
      has_access_token: Boolean(tokens.access_token),
      has_refresh_token: Boolean(tokens.refresh_token),
      expires_in: tokens.expires_in
    });
  }
  const division = await fetchCurrentDivision(tokens.access_token);
  if (EXACT_DEBUG_LOGS) {
    logger.debug("OAuth division fetch debug", { division });
  }
  const expiresInSeconds = Number(tokens.expires_in || 0);
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

  await upsertOAuthSession({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: expiresAt,
    division
  });

  logger.info("Exact OAuth session stored", { division, expires_at: expiresAt });

  return {
    ok: true,
    statusCode: 200,
    body: {
      message: "Exact OAuth connected successfully.",
      division,
      expires_at: expiresAt
    }
  };
}

module.exports = {
  buildExactAuthUrl,
  parseOauthCallback,
  exchangeCodeForTokens,
  refreshAccessToken,
  ensureValidAccessToken,
  getExactBaseUrl,
  fetchCurrentDivision,
  handleOauthCallback,
  upsertOAuthSession,
  getOAuthSession,
  clearOAuthSession,
  isAccessTokenExpired
};
