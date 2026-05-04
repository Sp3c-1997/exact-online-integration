const { fetchSalesInvoices } = require("../services/invoiceService");
const { enrichInvoicesWithDebtorEmail } = require("../services/accountService");
const logger = require("../lib/logger");
const { EXACT_DEBUG_LOGS } = require("../lib/flags");

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// 🔹 Replace with actual backend URL (env)
const COLLECT_PAYMENT_URL = process.env.COLLECT_PAYMENT_URL;
const COLLECT_PAYMENT_TIMEOUT_MS = Number(process.env.COLLECT_PAYMENT_TIMEOUT_MS || 15000);

/**
 * Call client backend to trigger payment
 */
async function triggerPayment(payload) {
    if (!COLLECT_PAYMENT_URL) {
        throw new Error("Missing COLLECT_PAYMENT_URL");
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), COLLECT_PAYMENT_TIMEOUT_MS);

    let res;
    try {
        res = await fetch(COLLECT_PAYMENT_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
    } catch (error) {
        if (error?.name === "AbortError") {
            throw new Error(`Payment API timeout after ${COLLECT_PAYMENT_TIMEOUT_MS}ms`);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }

    const text = await res.text();

    if (!res.ok) {
        throw new Error(`Payment API ${res.status}: ${text.slice(0, 300)}`);
    }

    return text ? JSON.parse(text) : {};
}

/**
 * Filter only valid invoices for processing
 */
function filterProcessableInvoices(invoices) {
    return invoices.filter((inv) => {
        if (!inv) return false;
        if (inv.is_finalized !== true) return false;
        if (typeof inv.amount_cents !== "number" || inv.amount_cents <= 0) return false;
        if (!inv.exact_debtor_id) return false;
        if (!inv.invoice_number) return false;
        return true;
    });
}

function parseInvoiceDateValue(value) {
    if (!value) return null;

    // Exact OData often returns dates as "/Date(1714473600000)/".
    const raw = String(value).trim();
    const exactMatch = /^\/Date\((-?\d+)(?:[+-]\d+)?\)\/$/.exec(raw);
    if (exactMatch) {
        const millis = Number(exactMatch[1]);
        if (!Number.isNaN(millis)) {
            const dateFromMillis = new Date(millis);
            if (!Number.isNaN(dateFromMillis.getTime())) {
                return dateFromMillis;
            }
        }
    }

    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
}

function filterInvoicesWithinWindow(invoices, windowStartMs) {
    return invoices.filter((inv) => {
        if (!inv) return false;
        const created = parseInvoiceDateValue(inv.created_at);
        const modified = parseInvoiceDateValue(inv.modified_at);
        const isCreatedInWindow = created ? created.getTime() >= windowStartMs : false;
        const isModifiedInWindow = modified ? modified.getTime() >= windowStartMs : false;
        return isCreatedInWindow || isModifiedInWindow;
    });
}

/**
 * Main job logic
 */
async function pollInvoices() {
    logger.info("Polling invoices...");

    // 🔹 Last 7 days window
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const sevenDaysAgoMs = sevenDaysAgo.getTime();
    const windowStartIso = sevenDaysAgo.toISOString();
    const filter = `(Created ge datetime'${windowStartIso}' or Modified ge datetime'${windowStartIso}')`;

    // 1. Fetch all pages for recent invoices
    // Use skip-based pagination so we are not dependent on Exact returning `__next`.
    const pageSize = 100;
    const allInvoices = [];
    let skip = 0;
    do {
        const page = await fetchSalesInvoices({
            top: pageSize,
            skip,
            filter,
            orderby: "Created desc"
        });
        const pageInvoices = Array.isArray(page.invoices) ? page.invoices : [];
        allInvoices.push(...pageInvoices);
        // If we got a full page, there may be more rows.
        skip += pageSize;
        if (pageInvoices.length < pageSize) {
            break;
        }
    } while (true);

    const invoices = allInvoices;
    const recentInvoices = filterInvoicesWithinWindow(invoices, sevenDaysAgoMs);

    logger.info(`Fetched ${invoices.length} invoices`);
    logger.info(`Invoices inside local 7-day window: ${recentInvoices.length}`);

    // 2. Enrich (get emails)
    const enriched = await enrichInvoicesWithDebtorEmail(recentInvoices);

    // 3. Filter valid
    const processable = filterProcessableInvoices(enriched);

    logger.info(`Processable invoices: ${processable.length}`);
    logger.info("Processable invoices", { processable });

    // 4. Process each
    for (const inv of processable) {
        const id = inv.deduplication_id;

        // Missing email → skip
        if (!inv.debtor_email) {
            logger.warn("Skipping invoice (no email)", {
                invoice: inv.invoice_number
            });
            continue;
        }

        try {
            const payload = {
                email: inv.debtor_email,
                amount: inv.amount_cents,
                description: `Invoice ${inv.invoice_number}`,
                invoice_number: inv.invoice_number,
                exact_debtor_id: inv.exact_debtor_id,
                idempotency_key: id ? `exact-${id}` : undefined
            };

            if (EXACT_DEBUG_LOGS) {
                logger.info("Collect payment request payload (dev only)", { payload });
            }
            await triggerPayment(payload);

            logger.info("Invoice payment triggered", {
                invoice: inv.invoice_number
            });
        } catch (err) {
            logger.error("Failed to process invoice", {
                invoice: inv.invoice_number,
                message: err.message
            });
        }
    }
}

/**
 * Safe polling loop (no overlap)
 */
async function startPolling() {
    logger.info("Invoice polling service started");

    while (true) {
        try {
            await pollInvoices();
        } catch (err) {
            logger.error("Polling cycle failed", {
                message: err.message
            });
        }

        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
}

module.exports = {
    startPolling
};