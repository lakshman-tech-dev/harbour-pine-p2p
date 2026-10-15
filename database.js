const path = require("node:path");
const Database = require("better-sqlite3");

const fs = require("node:fs");
const dataDirectory = path.join(__dirname, "data");

fs.mkdirSync(dataDirectory, { recursive: true });
const db = new Database(path.join(dataDirectory, "harbour-pine.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS exceptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_code TEXT NOT NULL,
    plant TEXT NOT NULL,
    storage_location TEXT NOT NULL,
    cost_centre TEXT NOT NULL,
    material TEXT NOT NULL,
    material_desc TEXT NOT NULL,
    business_partner TEXT NOT NULL,
    document_id TEXT NOT NULL CHECK (document_id GLOB '[A-Z][A-Z]-[0-9][0-9][0-9][0-9][0-9][0-9]'),
    amount REAL NOT NULL CHECK (amount > 0),
    invoice_date TEXT NOT NULL,
    requested_date TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('Open', 'InReview', 'Escalated', 'Resolved')),
    exception_type TEXT NOT NULL CHECK (exception_type IN (
      'PriceMismatch', 'QuantityVariance', 'MissingGR',
      'DuplicateInvoice', 'MasterDataError', 'ApprovalTimeout'
    )),
    owner TEXT NOT NULL,
    aging_days INTEGER NOT NULL DEFAULT 0,
    risk_score INTEGER NOT NULL DEFAULT 0,
    risk_band TEXT NOT NULL DEFAULT 'Low',
    sla_deadline TEXT NOT NULL,
    sla_breached INTEGER NOT NULL DEFAULT 0,
    recurrence_flag INTEGER NOT NULL DEFAULT 0 CHECK (recurrence_flag IN (0, 1))
  );

  CREATE TABLE IF NOT EXISTS resolution_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exception_id INTEGER NOT NULL REFERENCES exceptions(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    performed_by TEXT NOT NULL,
    comment TEXT NOT NULL,
    timestamp TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_exceptions_status ON exceptions(status);
  CREATE INDEX IF NOT EXISTS idx_exceptions_type ON exceptions(exception_type);
  CREATE INDEX IF NOT EXISTS idx_resolution_log_exception
    ON resolution_log(exception_id, timestamp DESC);
`);

const today = new Date();
const dateOffset = (offset) => {
  const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset));
  return date.toISOString().slice(0, 10);
};
const deadlineFor = (invoiceDate) => {
  const deadline = new Date(`${invoiceDate}T00:00:00.000Z`);
  deadline.setUTCDate(deadline.getUTCDate() + 5);
  return deadline.toISOString().slice(0, 10);
};

const count = db.prepare("SELECT COUNT(*) AS count FROM exceptions").get().count;
if (count === 0) {
  const records = [
    {
      company_code: "1000", plant: "1107", storage_location: "SL14", cost_centre: "CC-2225",
      material: "SD-480", material_desc: "Servo Drive SD-480", business_partner: "Greenford Utilities",
      document_id: "SO-460025", amount: 46875, invoice_date: "2026-09-10", requested_date: "2026-09-18",
      status: "Open", exception_type: "PriceMismatch", owner: "AP_CLERK", recurrence_flag: 0
    },
    {
      company_code: "1000", plant: "1107", storage_location: "SL02", cost_centre: "CC-1140",
      material: "PL-220", material_desc: "Pallet Wrap 500mm", business_partner: "Northstar Packaging Ltd",
      document_id: "IV-460026", amount: 3480.5, invoice_date: dateOffset(-2), requested_date: dateOffset(4),
      status: "InReview", exception_type: "QuantityVariance", owner: "AP_CLERK", recurrence_flag: 0
    },
    {
      company_code: "1000", plant: "1204", storage_location: "SL08", cost_centre: "CC-3088",
      material: "EL-704", material_desc: "LED High Bay 150W", business_partner: "Bristol Electrical Supplies",
      document_id: "IV-460027", amount: 12750, invoice_date: dateOffset(-12), requested_date: dateOffset(-4),
      status: "Open", exception_type: "MissingGR", owner: "AP_CLERK", recurrence_flag: 0
    },
    {
      company_code: "1000", plant: "1107", storage_location: "SL14", cost_centre: "CC-2225",
      material: "HV-118", material_desc: "Hydraulic Valve Assembly", business_partner: "Midlands Fluid Systems",
      document_id: "IV-460028", amount: 6250, invoice_date: dateOffset(-8), requested_date: dateOffset(-1),
      status: "Escalated", exception_type: "DuplicateInvoice", owner: "AP_MANAGER", recurrence_flag: 1
    },
    {
      company_code: "2000", plant: "2102", storage_location: "SL03", cost_centre: "CC-4410",
      material: "OF-510", material_desc: "Office Chair, Ergonomic", business_partner: "Leeds Office Interiors",
      document_id: "IV-460029", amount: 865, invoice_date: dateOffset(-4), requested_date: dateOffset(3),
      status: "Open", exception_type: "MasterDataError", owner: "AP_CLERK", recurrence_flag: 0
    },
    {
      company_code: "1000", plant: "1301", storage_location: "SL11", cost_centre: "CC-5170",
      material: "SA-330", material_desc: "Safety Boots S3", business_partner: "Cymru Safety Wear",
      document_id: "IV-460030", amount: 1840, invoice_date: dateOffset(-35), requested_date: dateOffset(-28),
      status: "Open", exception_type: "ApprovalTimeout", owner: "AP_CLERK", recurrence_flag: 0
    },
    {
      company_code: "2000", plant: "2205", storage_location: "SL06", cost_centre: "CC-6203",
      material: "CH-205", material_desc: "Commercial Chiller Unit", business_partner: "Thames Catering Equipment",
      document_id: "IV-460031", amount: 52800, invoice_date: dateOffset(-18), requested_date: dateOffset(-10),
      status: "Resolved", exception_type: "PriceMismatch", owner: "AP_MANAGER", recurrence_flag: 0
    },
    {
      company_code: "1000", plant: "1107", storage_location: "SL14", cost_centre: "CC-2225",
      material: "PK-090", material_desc: "Corrugated Carton 400x300", business_partner: "Greenford Utilities",
      document_id: "IV-460032", amount: 9650, invoice_date: dateOffset(-7), requested_date: dateOffset(0),
      status: "InReview", exception_type: "QuantityVariance", owner: "AP_SPECIALIST", recurrence_flag: 0
    },
    {
      company_code: "2000", plant: "2303", storage_location: "SL09", cost_centre: "CC-7032",
      material: "MT-640", material_desc: "Stainless Fixing Kit", business_partner: "Yorkshire Industrial Fasteners",
      document_id: "IV-460033", amount: 2740, invoice_date: dateOffset(-10), requested_date: dateOffset(-2),
      status: "Open", exception_type: "MissingGR", owner: "AP_CLERK", recurrence_flag: 0
    },
    {
      company_code: "1000", plant: "1408", storage_location: "SL05", cost_centre: "CC-8104",
      material: "IT-815", material_desc: "Handheld Stock Scanner", business_partner: "Newcastle Retail Technology",
      document_id: "IV-460034", amount: 15800, invoice_date: dateOffset(-1), requested_date: dateOffset(6),
      status: "Open", exception_type: "ApprovalTimeout", owner: "AP_CLERK", recurrence_flag: 0
    }
  ];

  const insertException = db.prepare(`
    INSERT INTO exceptions (
      company_code, plant, storage_location, cost_centre, material, material_desc,
      business_partner, document_id, amount, invoice_date, requested_date,
      status, exception_type, owner, aging_days, risk_score, risk_band,
      sla_deadline, sla_breached, recurrence_flag
    ) VALUES (
      @company_code, @plant, @storage_location, @cost_centre, @material, @material_desc,
      @business_partner, @document_id, @amount, @invoice_date, @requested_date,
      @status, @exception_type, @owner, 0, 0, 'Low',
      @sla_deadline, 0, @recurrence_flag
    )
  `);
  const insertLog = db.prepare(`
    INSERT INTO resolution_log (exception_id, action, performed_by, comment, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);

  const seed = db.transaction(() => {
    records.forEach((record) => {
      const result = insertException.run({ ...record, sla_deadline: deadlineFor(record.invoice_date) });
      if (record.status === "Escalated") {
        insertLog.run(result.lastInsertRowid, "Escalate", "AP_MANAGER", "Escalated for duplicate invoice review.", new Date().toISOString());
      } else if (record.status === "Resolved") {
        insertLog.run(result.lastInsertRowid, "Resolve", "AP_MANAGER", "Price corrected and invoice cleared for payment.", new Date().toISOString());
      }
    });
  });
  seed();
}

module.exports = db;
