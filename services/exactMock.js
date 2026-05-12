const fs = require("fs");
const path = require("path");
const logger = require("../lib/logger");

const DATA_DIR = path.join(__dirname, "..", "data", "exact-mock");

let loggedOnce = false;
let cacheAccounts = null;
let cacheInvoices = null;

function isExactMockEnabled() {
  const v = process.env.EXACT_MOCK;
  return v === "1" || String(v).toLowerCase() === "true" || String(v).toLowerCase() === "yes";
}

function loadAccounts() {
  if (cacheAccounts) {
    return cacheAccounts;
  }
  const p = path.join(DATA_DIR, "accounts.json");
  const raw = fs.readFileSync(p, "utf8");
  cacheAccounts = JSON.parse(raw);
  if (!Array.isArray(cacheAccounts)) {
    throw new Error("accounts.json must be a JSON array");
  }
  return cacheAccounts;
}

function loadInvoices() {
  if (cacheInvoices) {
    return cacheInvoices;
  }
  const p = path.join(DATA_DIR, "sales-invoices.json");
  const raw = fs.readFileSync(p, "utf8");
  cacheInvoices = JSON.parse(raw);
  if (!Array.isArray(cacheInvoices)) {
    throw new Error("sales-invoices.json must be a JSON array");
  }
  return cacheInvoices;
}

/**
 * @param {string} filter OData fragment e.g. Status eq 50
 * @param {Array<object>} rows
 */
function applyInvoiceFilter(filter, rows) {
  if (!filter || !String(filter).trim()) {
    return rows;
  }
  // Minimal: "Status eq 20" or "Status eq 50" (and spaces)
  const m = String(filter).match(/Status\s+eq\s+(\d+)/i);
  if (!m) {
    return rows;
  }
  const want = Number(m[1]);
  return rows.filter((r) => Number(r.Status) === want);
}

/**
 * @param {string} filter e.g. ID eq guid'...' with optional doubled quotes
 */
function parseAccountIdFilter(filter) {
  if (!filter) {
    return null;
  }
  const m = String(filter).match(/ID\s+eq\s+guid'((?:''|[^'])*)'/i);
  if (!m) {
    return null;
  }
  return m[1].replace(/''/g, "'");
}

/**
 * @param {string} pathWithQuery
 * @returns {URL} relative path+search on a throwaway base for parsing
 */
function toURL(pathWithQuery) {
  const raw = String(pathWithQuery).trim();
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return new URL(raw);
  }
  return new URL(raw.replace(/^\//, ""), "https://mock.exact.local/");
}

function isAccountsRequest(pathname) {
  return /\/crm\/Accounts$/i.test(pathname) || /^crm\/Accounts$/i.test(pathname.replace(/^\//, ""));
}

function isSalesInvoicesRequest(pathname) {
  return /SalesInvoices$/i.test(pathname) || /salesinvoice\/SalesInvoices$/i.test(pathname.replace(/^\//, ""));
}

/**
 * Serves the same shape as Exact OData: { d: { results, __next? } }.
 * @param {string} pathWithQuery
 * @returns {object}
 */
function getMockJsonObject(pathWithQuery) {
  if (!loggedOnce) {
    loggedOnce = true;
    logger.info("EXACT_MOCK: using JSON fixtures in data/exact-mock/ (set EXACT_MOCK=0 to use live Exact API)");
  }

  const u = toURL(pathWithQuery);
  const pathname = u.pathname;
  const searchParams = u.searchParams;

  if (isAccountsRequest(pathname)) {
    const filter = searchParams.get("$filter");
    const guid = parseAccountIdFilter(filter);
    const accounts = loadAccounts();
    const row = guid ? accounts.find((a) => String(a.ID).toLowerCase() === String(guid).toLowerCase()) : null;
    if (!row) {
      return { d: { results: [] } };
    }
    return { d: { results: [row] } };
  }

  if (isSalesInvoicesRequest(pathname)) {
    const all = loadInvoices();
    const filtered = applyInvoiceFilter(searchParams.get("$filter"), all);
    const top = Math.min(1000, Math.max(1, Number(searchParams.get("$top") || 100)));
    const skip = Math.max(0, Number(searchParams.get("$skip") || 0));
    const page = filtered.slice(skip, skip + top);
    const d = { results: page };
    if (skip + top < filtered.length) {
      const next = new URL("https://start.exactonline.nl/api/v1/0/salesinvoice/SalesInvoices");
      for (const [k, v] of searchParams) {
        if (k === "$skip") {
          next.searchParams.set(k, String(skip + top));
        } else {
          next.searchParams.set(k, v);
        }
      }
      if (!searchParams.has("$skip")) {
        next.searchParams.set("$skip", String(skip + top));
      }
      d.__next = next.toString();
    }
    return { d };
  }

  logger.warn("Exact mock: no handler for path (return empty d)", { path: pathWithQuery.slice(0, 200) });
  return { d: { results: [] } };
}

module.exports = {
  isExactMockEnabled,
  getMockJsonObject,
  DATA_DIR
};
