// Uses getJsonObjectWithRetry (max 3 attempts, 5xx/network + auth recovery) in exactClient
const { getJsonObjectWithRetry } = require("./exactClient");
const { enrichInvoicesWithDebtorEmail } = require("./accountService");
const logger = require("../lib/logger");
const { EXACT_DEBUG_LOGS } = require("../lib/flags");

/**
 * Document status codes (typical; confirm in Exact metadata for your administration).
 */
const SALES_INVOICE_STATUS = {
  /** Draft / not finalized (typical) */
  OPEN: 20,
  /** Booked / processed / printable — use for “ready to collect” */
  PROCESSED: 50
};

function isFinalized(status) {
  return status === SALES_INVOICE_STATUS.PROCESSED;
}

function isDraft(status) {
  return status === SALES_INVOICE_STATUS.OPEN;
}

/**
 * Full __next from Exact is an absolute URL. Normalize to host-relative path+query
 * so the client can re-fetch with the same auth flow (see exactClient `buildRequestUrl`).
 * @param {string|null|undefined} nextUrl
 * @returns {string|null}
 */
function normalizeNextUrl(nextUrl) {
  if (!nextUrl) {
    return null;
  }
  const url = new URL(nextUrl);
  return url.pathname + url.search;
}

/** OData $select for sales invoices (PascalCase per Exact). */
const SALES_INVOICE_FIELDS = [
  "InvoiceID",
  "InvoiceNumber",
  "Status",
  "Created",
  "Modified",
  "InvoiceDate",
  "AmountDC",
  "AmountFC",
  "InvoiceTo"
].join(",");

/**
 * Parse Exact OData list response: { d: { results: [...] } } or { d: { __count, results } }.
 */
function parseODataList(data) {
  if (!data?.d) {
    return { items: [], nextUrl: null };
  }

  // Exact can return plain array directly in `d` for some queries.
  if (Array.isArray(data.d)) {
    return {
      items: data.d,
      nextUrl: null
    };
  }

  if (Array.isArray(data.d.results)) {
    return {
      items: data.d.results,
      nextUrl: data.d.__next || null
    };
  }

  if (data.d.InvoiceID || data.d.InvoiceNumber != null) {
    return { items: [data.d], nextUrl: null };
  }

  return { items: [], nextUrl: null };
}

/**
 * Map a raw Exact row to a stable shape for your app and /collect-payment.
 * Amount for Stripe-style minor units: default currency (DC) * 100 (adjust if multi-decimal).
 *
 * Deduplication: use `deduplication_id` (Same as Exact `InvoiceID`, stable GUID), not `invoice_number`.
 */
function mapSalesInvoice(row) {
  const amountDc = row.AmountDC != null ? Number(row.AmountDC) : null;
  const amountCents =
    amountDc != null && !Number.isNaN(amountDc)
      ? Math.round(amountDc * 100)
      : null;
  const status = row.Status;

  return {
    id: row.InvoiceID,
    /** Use this in `processedInvoices` / idempotency — never rely on `invoice_number` alone */
    deduplication_id: row.InvoiceID != null ? String(row.InvoiceID) : null,
    invoice_number: row.InvoiceNumber != null ? String(row.InvoiceNumber) : null,
    status,
    created_at: row.Created != null ? String(row.Created) : null,
    modified_at: row.Modified != null ? String(row.Modified) : null,
    invoice_date: row.InvoiceDate != null ? String(row.InvoiceDate) : null,
    is_finalized: isFinalized(status),
    is_draft: isDraft(status),
    amount_dc: amountDc,
    amount_fc: row.AmountFC != null ? Number(row.AmountFC) : null,
    /** minor units in company currency, for SEPA body `amount` */
    amount_cents: amountCents,
    /** Debtor (customer) account GUID */
    exact_debtor_id: row.InvoiceTo != null ? String(row.InvoiceTo) : null
  };
}

/**
 * Fetch sales invoices for the current division (session).
 * @param {object} [options]
 * @param {number} [options.top=100] OData $top
 * @param {number} [options.skip=0] OData $skip
 * @param {string} [options.filter] OData $filter (e.g. status / date) — add when needed
 * @param {string} [options.orderby="Created desc"] OData $orderby for stable paging
 * @param {string} [options.nextPath] — normalized `next` from a previous page (pathname+query, full URL, or entity path)
 */
async function fetchSalesInvoices(options = {}) {
  const { top = 100, skip = 0, filter, orderby = "Created desc", nextPath } = options;

  let data;
  if (nextPath) {
    data = await getJsonObjectWithRetry(String(nextPath).trim());
  } else {
    const params = new URLSearchParams();
    params.set("$select", SALES_INVOICE_FIELDS);
    params.set("$top", String(Math.min(Math.max(1, top), 1000)));
    if (skip > 0) {
      params.set("$skip", String(skip));
    }
    if (orderby) {
      params.set("$orderby", String(orderby));
    }
    if (filter) {
      params.set("$filter", filter);
    }
    const path = `salesinvoice/SalesInvoices?${params.toString()}`;
    data = await getJsonObjectWithRetry(path);
  }

  // Testing-only visibility: full raw response from Exact before parse/map.
  if (EXACT_DEBUG_LOGS) {
    logger.debug("Exact SalesInvoices raw response", { data });
  }

  const { items, nextUrl } = parseODataList(data);

  return {
    invoices: items.map(mapSalesInvoice),
    /** Host-relative path + query; pass to the next `fetchSalesInvoices({ nextPath: next })` */
    next: normalizeNextUrl(nextUrl)
  };
}

/**
 * Same as `fetchSalesInvoices`, then loads CRM `Accounts` for each unique `exact_debtor_id`
 * and sets `debtor_email` (and optionally `debtor_name`) on each invoice.
 *
 * @param {object} [options] — same as `fetchSalesInvoices`, plus:
 * @param {boolean} [options.include_debtor_name] — also set `debtor_name` from Account
 */
async function fetchSalesInvoicesWithDebtorEmails(options = {}) {
  const { include_debtor_name: includeDebtorName, ...rest } = options;
  const result = await fetchSalesInvoices(rest);
  logger.info("Fetched sales invoices (before debtor email merge)", { count: result.invoices.length });
  const invoices = await enrichInvoicesWithDebtorEmail(result.invoices, {
    includeName: Boolean(includeDebtorName)
  });
  return { ...result, invoices };
}

module.exports = {
  fetchSalesInvoices,
  fetchSalesInvoicesWithDebtorEmails,
  mapSalesInvoice,
  normalizeNextUrl,
  isFinalized,
  isDraft,
  SALES_INVOICE_STATUS,
  SALES_INVOICE_FIELDS
};
