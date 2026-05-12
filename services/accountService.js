// getJsonObjectWithRetry: see exactClient (retries 5xx/network, auth)
const { getJsonObjectWithRetry } = require("./exactClient");
const logger = require("../lib/logger");
const { EXACT_DEBUG_LOGS } = require("../lib/flags");

const ACCOUNT_FIELDS = ["ID", "Name", "Email"].join(",");

const CONCURRENT_ACCOUNT_FETCHES = 5;

function parseODataList(data) {
  if (!data?.d) {
    return { items: [] };
  }
  if (Array.isArray(data.d)) {
    return { items: data.d };
  }
  if (Array.isArray(data.d.results)) {
    return { items: data.d.results };
  }
  if (data.d.ID) {
    return { items: [data.d] };
  }
  return { items: [] };
}

/**
 * Build OData filter for Account primary key (GUID).
 * @param {string} guid
 */
function filterByAccountId(guid) {
  return `ID eq guid'${String(guid).replace(/'/g, "''")}'`;
}

/** Minimal: empty or without "@" is not usable for debtor email. */
function normalizeAccountEmail(value) {
  if (value == null) {
    return null;
  }
  const s = String(value).trim();
  if (s.length === 0) {
    return null;
  }
  if (!s.includes("@")) {
    return null;
  }
  return s;
}

/**
 * @param {string} accountGuid
 * @returns {Promise<{ id: string, name: string|null, email: string|null }|null>}
 */
async function fetchAccountById(accountGuid) {
  if (!accountGuid) {
    return null;
  }

  const params = new URLSearchParams();
  params.set("$select", ACCOUNT_FIELDS);
  params.set("$top", "1");
  params.set("$filter", filterByAccountId(accountGuid));

  const path = `crm/Accounts?${params.toString()}`;
  const data = await getJsonObjectWithRetry(path);
  if (EXACT_DEBUG_LOGS) {
    logger.debug("Exact CRM Accounts raw debtor response", {
      debtor_id: String(accountGuid),
      data
    });
  }
  const { items } = parseODataList(data);
  const row = items[0];
  if (!row) {
    // Empty OData result: no CRM row for this GUID (not a transport failure)
    logger.info("CRM account not found (no row for debtor id)", { debtor_id: String(accountGuid).slice(0, 8) + "…" });
    return null;
  }

  const rawEmail = row.Email;
  const email = normalizeAccountEmail(row.Email);
  if (rawEmail != null && String(rawEmail).trim() !== "" && email == null) {
    logger.info("CRM account email empty or invalid, using no email", { debtor_id: String(row.ID).slice(0, 8) + "…" });
  }

  return {
    id: row.ID != null ? String(row.ID) : null,
    name: row.Name != null ? String(row.Name) : null,
    email
  };
}

/**
 * Run async tasks with limited concurrency.
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<void>} fn
 * @template T
 */
async function runPool(items, limit, fn) {
  const q = [...items];
  const workers = Array.from({ length: Math.min(limit, q.length) }, async () => {
    while (q.length) {
      const item = q.shift();
      if (item !== undefined) {
        await fn(item);
      }
    }
  });
  await Promise.all(workers);
}

/**
 * Adds `debtor_email` (and optional `debtor_name`) to each invoice from CRM Accounts.
 * One request per unique `exact_debtor_id` (cached).
 *
 * @param {Array<{ exact_debtor_id?: string|null }>} invoices
 * @param {object} [options]
 * @param {boolean} [options.includeName]
 */
async function enrichInvoicesWithDebtorEmail(invoices, options = {}) {
  const { includeName = false } = options;
  const list = Array.isArray(invoices) ? invoices : [];

  const uniqueIds = [...new Set(list.map((inv) => inv.exact_debtor_id).filter(Boolean).filter((id) => typeof id === "string" && id.trim()))];
  const emailById = new Map();
  const nameById = new Map();

  logger.info("Enriching invoices with debtor emails", {
    invoiceCount: list.length,
    uniqueDebtors: uniqueIds.length
  });

  await runPool(
    uniqueIds,
    CONCURRENT_ACCOUNT_FETCHES,
    async (id) => {
      try {
        const acc = await fetchAccountById(id);
        if (acc) {
          emailById.set(String(id), acc.email);
          if (includeName) {
            nameById.set(String(id), acc.name);
          }
        } else {
          // No row was logged inside fetchAccountById; here we only cache null
          emailById.set(String(id), null);
        }
      } catch (err) {
        // Request/Exact failure (distinguish from "account not found" path above)
        const code = err && typeof err === "object" ? err.code : undefined;
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("CRM account request failed for debtor", {
          id: String(id).slice(0, 8) + "…",
          message,
          code: code != null ? code : undefined
        });
        emailById.set(String(id), null);
        if (includeName) {
          nameById.set(String(id), null);
        }
      }
    }
  );

  return list.map((inv) => {
    const id = inv.exact_debtor_id != null ? String(inv.exact_debtor_id) : null;
    const out = {
      ...inv,
      debtor_email: id ? emailById.get(id) ?? null : null
    };
    if (includeName) {
      out.debtor_name = id ? nameById.get(id) ?? null : null;
    }
    if (id && !emailById.get(id)) {
      logger.info("Debtor missing email", {
        debtor_id: id.slice(0, 8) + "…"
      });
    }
    return out;
  });
}

module.exports = {
  fetchAccountById,
  enrichInvoicesWithDebtorEmail,
  ACCOUNT_FIELDS
};
