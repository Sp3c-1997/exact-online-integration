require("dotenv").config();

const express = require("express");
const cors = require("cors");

const {
  buildExactAuthUrl,
  handleOauthCallback
} = require("./services/oauthService");

const {
  fetchSalesInvoices,
  fetchSalesInvoicesWithDebtorEmails
} = require("./services/invoiceService");

const { startPolling } = require("./jobs/pollInvoices");

const logger = require("./lib/logger");
const { errMessage, statusForIntegrationError } = require("./lib/errorUtils");
const { EXACT_DEBUG_LOGS } = require("./lib/flags");

const app = express();
const port = Number(process.env.PORT || 3000);

// 🔹 Middlewares
app.use(cors());
app.use(express.json());

// 🔹 Request logging
app.use((req, res, next) => {
  if (req.path === "/health" || req.path === "/favicon.ico") {
    return next();
  }

  const start = Date.now();

  res.on("finish", () => {
    logger.info("http", {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - start
    });
  });

  next();
});

// 🔹 Health check
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "exactonline-integration" });
});

// 🔹 OAuth start
app.get("/oauth/start", (_req, res) => {
  try {
    const authUrl = buildExactAuthUrl();
    res.json({ authUrl });
  } catch (error) {
    const message = errMessage(error);
    logger.error("oauth/start failed", { message });

    res.status(500).json({
      error: "oauth_config_error",
      message
    });
  }
});

// 🔹 OAuth callback
app.get("/oauth/callback", async (req, res) => {
  try {
    const result = await handleOauthCallback(req.query);

    if (!result.ok) {
      return res.status(result.statusCode).json(result.body);
    }

    return res.send("OAuth connected successfully. You can close this tab.");
  } catch (error) {
    const message = errMessage(error);

    logger.error("oauth/callback failed", {
      message,
      stack: error instanceof Error ? error.stack : undefined
    });

    return res.status(500).json({
      error: "oauth_callback_failed",
      message
    });
  }
});

// 🔹 Debug invoices endpoint (disabled in production)
app.get("/invoices", async (req, res) => {
  // if (process.env.NODE_ENV === "production") {
  //   return res.status(403).json({ error: "disabled_in_production" });
  // }

  try {
    const top = req.query.top ? Number(req.query.top) : undefined;
    const skip = req.query.skip ? Number(req.query.skip) : undefined;
    const filter = req.query.$filter || req.query.filter || undefined;
    const orderby = req.query.$orderby || req.query.orderby || undefined;
    const nextPath = req.query.next || undefined;

    const skipEmail =
      req.query.include_debtor_email === "0" ||
      String(req.query.include_debtor_email).toLowerCase() === "false";

    const includeDebtorName =
      req.query.include_debtor_name === "1" ||
      String(req.query.include_debtor_name).toLowerCase() === "true";

    const base = { top, skip, filter, orderby, nextPath };

    const result = skipEmail
      ? await fetchSalesInvoices(base)
      : await fetchSalesInvoicesWithDebtorEmails({
        ...base,
        include_debtor_name: includeDebtorName
      });

    logger.info("invoices fetch result summary", {
      count: Array.isArray(result?.invoices) ? result.invoices.length : 0,
      top,
      skip,
      filter,
      orderby,
      next: result?.next || null
    });
    if (EXACT_DEBUG_LOGS) {
      logger.debug("invoices fetch result full payload", { invoices: result?.invoices || [] });
    }

    return res.json(result);
  } catch (error) {
    const message = errMessage(error);
    const status = statusForIntegrationError(error, message);

    logger.error("invoices fetch failed", { message, status });

    return res.status(status).json({
      error: "invoices_fetch_failed",
      message:
        process.env.NODE_ENV === "production" && status === 500
          ? "Could not load invoices"
          : message
    });
  }
});

// 🔹 Global error handler
app.use((err, req, res, _next) => {
  if (res.headersSent) return;

  const message = errMessage(err);

  logger.error("unhandled error", {
    message,
    path: req.path,
    stack: err instanceof Error ? err.stack : undefined
  });

  const isProd = process.env.NODE_ENV === "production";

  return res.status(500).json(
    isProd
      ? { error: "internal_error", message: "Internal server error" }
      : { error: "internal_error", message, stack: err instanceof Error ? err.stack : undefined }
  );
});

// 🔹 Start server + polling
app.listen(port, () => {
  const mode = process.env.NODE_ENV || "development";

  logger.info("Server started", { port, mode });

  // 🚀 Start polling AFTER server is up
  startPolling();

  logger.info("Invoice polling started (5 min interval)");
});