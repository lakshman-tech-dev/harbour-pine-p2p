require("dotenv").config();

const express = require("express");
const path = require("node:path");
const db = require("./database");

const app = express();
const port = Number(process.env.PORT) || 3000;
const VALID_STATUSES = new Set(["Open", "InReview", "Escalated", "Resolved"]);
const VALID_TYPES = new Set([
  "PriceMismatch", "QuantityVariance", "MissingGR",
  "DuplicateInvoice", "MasterDataError", "ApprovalTimeout"
]);
const VALID_ROLES = new Set(["AP_CLERK", "AP_MANAGER", "AP_SPECIALIST", "PROCUREMENT"]);
const BASE_RISK = {
  PriceMismatch: 40,
  QuantityVariance: 35,
  MissingGR: 45,
  DuplicateInvoice: 50,
  MasterDataError: 30,
  ApprovalTimeout: 55
};

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

function dayDifference(from, to) {
  const start = new Date(`${from}T00:00:00.000Z`).getTime();
  const end = new Date(`${to}T00:00:00.000Z`).getTime();
  return Math.max(0, Math.floor((end - start) / 86400000));
}

function calculateException(record) {
  const agingDays = dayDifference(record.invoice_date, utcToday());
  const deadlineDate = new Date(`${record.invoice_date}T00:00:00.000Z`);
  deadlineDate.setUTCDate(deadlineDate.getUTCDate() + 5);
  const slaDeadline = deadlineDate.toISOString().slice(0, 10);
  let riskScore = BASE_RISK[record.exception_type] || 0;

  if (agingDays > 7) riskScore += 10;
  if (agingDays > 14) riskScore += 20;
  if (agingDays > 30) riskScore += 30;
  if (record.amount > 10000) riskScore += 10;
  if (record.amount > 50000) riskScore += 15;
  riskScore = Math.min(100, riskScore);

  let riskBand = "Low";
  if (riskScore >= 80) riskBand = "Critical";
  else if (riskScore >= 60) riskBand = "High";
  else if (riskScore >= 40) riskBand = "Medium";

  return {
    ...record,
    aging_days: agingDays,
    risk_score: riskScore,
    risk_band: riskBand,
    sla_deadline: slaDeadline,
    sla_breached: utcToday() > slaDeadline
  };
}

function getException(id) {
  const record = db.prepare("SELECT * FROM exceptions WHERE id = ?").get(id);
  return record ? calculateException(record) : null;
}

function validDocumentId(documentId) {
  return typeof documentId === "string" && /^[A-Z]{2}-\d{6}$/.test(documentId);
}

function fallbackSummary(record) {
  return {
    summary: `${record.exception_type} exception for ${record.business_partner} on document ${record.document_id}. Review the invoice against the purchase order and supporting SAP documents.`,
    rootCauseIndicator: `Potential ${record.exception_type.replace(/([A-Z])/g, " $1").toLowerCase()} between invoice and SAP purchasing records.`,
    recommendedAction: "Compare the invoice with the PO and goods receipt in SAP, confirm the variance with the supplier, and document the outcome before release.",
    confidence: 0.42,
    fieldsUsed: ["exception_type", "business_partner", "document_id", "material", "amount", "aging_days"]
  };
}

function safeSummary(record, fallback = false) {
  return { ...fallbackSummary(record), fallback };
}

app.get("/api/exceptions", (req, res) => {
  const { status, type, risk_band: riskBand, search } = req.query;
  if (status && !VALID_STATUSES.has(String(status))) {
    return res.status(400).json({ error: "Invalid status filter." });
  }
  if (type && !VALID_TYPES.has(String(type))) {
    return res.status(400).json({ error: "Invalid exception type filter." });
  }
  const term = typeof search === "string" ? search.trim().toLowerCase() : "";
  let records = db.prepare("SELECT * FROM exceptions ORDER BY id ASC").all().map(calculateException);
  if (status) records = records.filter((record) => record.status === status);
  if (type) records = records.filter((record) => record.exception_type === type);
  if (riskBand) records = records.filter((record) => record.risk_band === riskBand);
  if (term) {
    records = records.filter((record) =>
      [record.document_id, record.business_partner, record.material, record.material_desc, record.owner]
        .some((value) => value.toLowerCase().includes(term))
    );
  }
  records.sort((a, b) => b.risk_score - a.risk_score || a.id - b.id);
  return res.json(records);
});

app.get("/api/exceptions/:id", (req, res) => {
  const record = getException(Number(req.params.id));
  if (!record) return res.status(404).json({ error: "Exception not found." });
  const resolutionLog = db.prepare(`
    SELECT id, exception_id, action, performed_by, comment, timestamp
    FROM resolution_log WHERE exception_id = ? ORDER BY timestamp DESC, id DESC
  `).all(record.id);
  return res.json({ ...record, resolution_log: resolutionLog });
});

app.patch("/api/exceptions/:id", (req, res) => {
  const id = Number(req.params.id);
  const record = getException(id);
  if (!record) return res.status(404).json({ error: "Exception not found." });

  const { status, owner, comment, performed_by: performedBy, attachment, document_id: documentId, amount } = req.body || {};
  if (typeof comment !== "string" || !comment.trim()) {
    return res.status(400).json({ error: "A comment is required before this action can be taken" });
  }
  if (performedBy && !VALID_ROLES.has(performedBy)) {
    return res.status(400).json({ error: "Invalid user role." });
  }
  if (owner !== undefined && (typeof owner !== "string" || owner.length > 80)) {
    return res.status(400).json({ error: "Owner must be a valid text value." });
  }
  if (status !== undefined && !VALID_STATUSES.has(status)) {
    return res.status(400).json({ error: "Invalid status." });
  }
  if (documentId !== undefined && !validDocumentId(documentId)) {
    return res.status(400).json({ error: "Document ID must match the XX-000000 pattern." });
  }
  if (amount !== undefined && (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0)) {
    return res.status(400).json({ error: "Amount must be a positive number." });
  }
  const role = performedBy || "AP_CLERK";
  const action = typeof req.body.action === "string" ? req.body.action : status || "Update";
  if (record.status === "Escalated" && status === "Resolved" && role !== "AP_MANAGER") {
    return res.status(403).json({ error: "This action requires AP Manager permission" });
  }
  if (record.status === "Resolved" && status === "Open") {
    return res.status(400).json({ error: "Resolved exceptions cannot go back to Open." });
  }

  const allowedActions = new Set(["Mark In Review", "Escalate", "Request Approval", "Resolve", "Update"]);
  if (!allowedActions.has(action)) {
    return res.status(400).json({ error: "Invalid resolution action." });
  }
  const logComment = attachment && typeof attachment === "string"
    ? `${comment.trim()}\nAttachment: ${attachment.trim()}`
    : comment.trim();
  const update = db.transaction(() => {
    const fields = [];
    const values = [];
    if (status !== undefined) {
      fields.push("status = ?");
      values.push(status);
    }
    if (owner !== undefined) {
      fields.push("owner = ?");
      values.push(owner);
    }
    if (documentId !== undefined) {
      fields.push("document_id = ?");
      values.push(documentId);
    }
    if (amount !== undefined) {
      fields.push("amount = ?");
      values.push(amount);
    }
    if (fields.length) {
      values.push(id);
      db.prepare(`UPDATE exceptions SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    }
    db.prepare(`
      INSERT INTO resolution_log (exception_id, action, performed_by, comment, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, action, role, logComment, new Date().toISOString());
  });
  update();
  const updatedRecord = getException(id);
  const resolutionLog = db.prepare(`
    SELECT id, exception_id, action, performed_by, comment, timestamp
    FROM resolution_log WHERE exception_id = ? ORDER BY timestamp DESC, id DESC
  `).all(id);
  return res.json({ ...updatedRecord, resolution_log: resolutionLog });
});

app.get("/api/kpis", (_req, res) => {
  const records = db.prepare("SELECT * FROM exceptions").all().map(calculateException);
  const resolutionLogs = db.prepare(`
    SELECT exception_id, action, timestamp FROM resolution_log ORDER BY timestamp DESC, id DESC
  `).all();
  const logsByException = new Map();
  for (const log of resolutionLogs) {
    const logs = logsByException.get(log.exception_id) || [];
    logs.push(log);
    logsByException.set(log.exception_id, logs);
  }
  const resolved = records.filter((record) => record.status === "Resolved");
  const resolutionDays = resolved.flatMap((record) => {
    const resolvedLog = (logsByException.get(record.id) || []).find((log) => log.action === "Resolve");
    return resolvedLog ? [dayDifference(record.invoice_date, resolvedLog.timestamp.slice(0, 10))] : [];
  });
  const breachedCount = records.filter((record) => record.sla_breached).length;
  const overdueValue = records
    .filter((record) => record.sla_breached && record.status !== "Resolved")
    .reduce((total, record) => total + record.amount, 0);
  const firstPassCount = resolved.filter((record) => {
    const logs = logsByException.get(record.id) || [];
    return logs.length === 1 && logs[0].action === "Resolve";
  }).length;
  const recurrenceCount = records.filter((record) => record.recurrence_flag).length;

  return res.json({
    exceptionCount: records.filter((record) => record.status !== "Resolved").length,
    overdueValue: Math.round(overdueValue * 100) / 100,
    avgResolutionDays: resolutionDays.length
      ? Math.round((resolutionDays.reduce((sum, days) => sum + days, 0) / resolutionDays.length) * 10) / 10
      : 0,
    firstPassYield: resolved.length ? Math.round((firstPassCount / resolved.length) * 1000) / 10 : 0,
    slaAdherence: records.length ? Math.round(((records.length - breachedCount) / records.length) * 1000) / 10 : 100,
    recurrenceRate: records.length ? Math.round((recurrenceCount / records.length) * 1000) / 10 : 0
  });
});

app.post("/api/summarise", async (req, res) => {
  const id = Number(req.body && req.body.exceptionId);
  const record = Number.isInteger(id) ? getException(id) : null;
  if (!record) return res.status(404).json({ error: "Exception not found." });

  if (!process.env.GEMINI_API_KEY) {
    return res.json(safeSummary(record, true));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
      {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text: "You assist a UK retailer's accounts-payable team. Return only valid JSON with keys summary, rootCauseIndicator, recommendedAction, confidence (0 to 1), and fieldsUsed (array of field names). Be concise and do not invent SAP evidence."
          }]
        },
        contents: [{
          parts: [{
            text: JSON.stringify({
              document_id: record.document_id,
              supplier: record.business_partner,
              material: record.material_desc,
              amount_gbp: record.amount,
              exception_type: record.exception_type,
              status: record.status,
              aging_days: record.aging_days,
              risk_band: record.risk_band,
              sla_breached: record.sla_breached
            })
          }]
        }],
        generationConfig: {
          maxOutputTokens: 350,
          responseMimeType: "application/json"
        }
      }),
      signal: controller.signal
      }
    );
    if (!response.ok) {
      console.error(`Gemini summarise request failed with HTTP ${response.status}.`);
      return res.json(safeSummary(record, true));
    }
    const payload = await response.json();
    const text = payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("");
    const parsed = text ? JSON.parse(text) : null;
    if (
      !parsed ||
      typeof parsed.summary !== "string" ||
      typeof parsed.rootCauseIndicator !== "string" ||
      typeof parsed.recommendedAction !== "string" ||
      typeof parsed.confidence !== "number" ||
      !Array.isArray(parsed.fieldsUsed)
    ) {
      console.error("Gemini summarise response did not match the expected JSON shape.");
      return res.json(safeSummary(record, true));
    }
    return res.json({
      summary: parsed.summary,
      rootCauseIndicator: parsed.rootCauseIndicator,
      recommendedAction: parsed.recommendedAction,
      confidence: Math.min(1, Math.max(0, parsed.confidence)),
      fieldsUsed: parsed.fieldsUsed.filter((field) => typeof field === "string"),
      fallback: false
    });
  } catch (error) {
    console.error("Gemini summarise request failed:", error.message);
    return res.json(safeSummary(record, true));
  } finally {
    clearTimeout(timeout);
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(port, () => {
  console.log(`Harbour & Pine P2P app listening on http://localhost:${port}`);
});
