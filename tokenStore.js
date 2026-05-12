const { getSupabase } = require("./supabaseClient");

const OAUTH_SESSION_TABLE = "exact_oauth_session";
const OAUTH_SESSION_ID = 1;

async function saveOAuthSession({ access_token, refresh_token, expires_at, division }) {
  const supabase = getSupabase();
  const payload = {
    id: OAUTH_SESSION_ID,
    access_token,
    refresh_token,
    expires_at,
    division,
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from(OAUTH_SESSION_TABLE)
    .upsert(payload, { onConflict: "id" })
    .select("access_token,refresh_token,expires_at,division")
    .single();

  if (error) {
    throw new Error(`Supabase save OAuth session failed: ${error.message}`);
  }

  return data;
}

async function getOAuthSession() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from(OAUTH_SESSION_TABLE)
    .select("access_token,refresh_token,expires_at,division")
    .eq("id", OAUTH_SESSION_ID)
    .maybeSingle();

  if (error) {
    throw new Error(`Supabase read OAuth session failed: ${error.message}`);
  }

  return data || null;
}

async function clearOAuthSession() {
  const supabase = getSupabase();
  const { error } = await supabase
    .from(OAUTH_SESSION_TABLE)
    .delete()
    .eq("id", OAUTH_SESSION_ID);

  if (error) {
    throw new Error(`Supabase clear OAuth session failed: ${error.message}`);
  }
}

const DEFAULT_EXPIRY_BUFFER_MS = 60_000;

async function isAccessTokenExpired() {
  const oauthSession = await getOAuthSession();
  if (!oauthSession || !oauthSession.expires_at) {
    return true;
  }

  return Date.now() >= new Date(oauthSession.expires_at).getTime();
}

/**
 * True when the access token is missing, expired, or within bufferMs of expiring
 * (use before API calls to refresh proactively).
 */
async function shouldRefreshAccessToken(bufferMs = DEFAULT_EXPIRY_BUFFER_MS) {
  const oauthSession = await getOAuthSession();
  if (!oauthSession || !oauthSession.expires_at) {
    return true;
  }
  const expiresAt = new Date(oauthSession.expires_at).getTime();
  return Date.now() >= expiresAt - bufferMs;
}

module.exports = {
  saveOAuthSession,
  getOAuthSession,
  clearOAuthSession,
  isAccessTokenExpired,
  shouldRefreshAccessToken
};
