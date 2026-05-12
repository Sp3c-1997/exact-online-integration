/**
 * Simple structured logging (stdout). Set EXACT_DEBUG_LOGS=1 for verbose output.
 * @param {string} level
 * @param {string} msg
 * @param {object} [meta]
 */
function line(level, msg, meta) {
  const t = new Date().toISOString();
  let extra = "";
  if (meta !== undefined && meta !== null) {
    try {
      extra = ` ${JSON.stringify(meta)}`;
    } catch {
      extra = ` ${String(meta)}`;
    }
  }
  const out = `[${t}] [${level}] ${msg}${extra}`;

  if (level === "ERROR") {
    console.error(out);
  } else {
    console.log(out);
  }
}

function shouldDebug() {
  return process.env.EXACT_DEBUG_LOGS === "1";
}

module.exports = {
  info: (msg, meta) => line("INFO", msg, meta),
  warn: (msg, meta) => line("WARN", msg, meta),
  error: (msg, meta) => line("ERROR", msg, meta),
  debug: (msg, meta) => {
    if (shouldDebug()) {
      line("DEBUG", msg, meta);
    }
  }
};
