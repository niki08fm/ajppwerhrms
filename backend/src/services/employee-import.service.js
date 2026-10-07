import ExcelJS from 'exceljs';
import { companyOf, employeeCoreSchema, employeeIdentitySchema } from '@ajpwer/shared';

const HEADERS = {
  code: 'Employee Number', name: 'Employee Name', joined_on: 'Joining Date',
  status: 'Employment Status', department: 'Department', designation: 'Job Title',
  pan: 'Pan Number', aadhaar: 'Aadhaar Card Number', uan: 'UAN', esi_number: 'ESI Number',
  bank_account: 'Account Number', bank_ifsc: 'IFSC Code', bank_name: 'Bank Name',
  pan_dob: 'Date of Birth on PAN', aadhaar_dob: 'Date of Birth on AADHAAR',
  gender: 'Gender on Aadhaar', phone: 'Phone', corporate_email: 'Tulfa Mail',
  personal_email: 'Personal Email', address: 'Address on Aadhaar',
  pf_details_available: 'PF Details Available', esi_enabled: 'ESI Eligible', pt_state: 'PT State',
};
const MISSING = /^(?:n\/?a|nil|none|null|not available|not applicable|not provided|unavailable|-+)$/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const normalizeHeader = (value) => value.trim().replace(/\s+/g, ' ').toLowerCase();

// Formula results and hyperlink labels are data only; no formula or external URL is evaluated.
function scalar(value) {
  if (value == null || value instanceof Date || typeof value !== 'object') return value;
  if (Array.isArray(value.richText)) return value.richText.map((part) => part.text ?? '').join('');
  if ('result' in value) return scalar(value.result);
  if ('text' in value) return scalar(value.text);
  return null;
}

function textOf(cell, identifier = false) {
  const value = scalar(cell?.value);
  if (value == null) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (identifier && !Number.isSafeInteger(value))) return '';
    const text = String(value);
    // Excel can store a numeric identifier with an explicit leading-zero display format.
    return identifier && /^0+$/.test(cell.numFmt ?? '') ? text.padStart(cell.numFmt.length, '0') : text;
  }
  if (value instanceof Date) return '';
  return String(value).trim();
}

const supplied = (value) => value && !MISSING.test(value) ? value : '';

function isoParts(year, month, day) {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Convert date-only report values without depending on the process timezone. */
export function normalizeReportDate(value, { date1904 = false } = {}) {
  value = scalar(value);
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    return isoParts(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < (date1904 ? 0 : 1)) return null;
    const serial = Math.floor(value);
    // Excel's 1900 date system includes a nonexistent 29 February 1900.
    if (!date1904 && serial === 60) return null;
    const adjusted = date1904 ? serial : serial - (serial > 60 ? 1 : 0);
    const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
    const date = new Date(epoch + adjusted * 86_400_000);
    return normalizeReportDate(date);
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) return isoParts(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})([/-])(\d{1,2})\2(\d{4})$/.exec(text);
  if (match) return isoParts(Number(match[4]), Number(match[3]), Number(match[1]));
  match = /^(\d{1,2})\s+([a-z]{3})\s+(\d{4})$/i.exec(text);
  if (match) return isoParts(Number(match[3]), MONTHS.indexOf(match[2].toLowerCase()) + 1, Number(match[1]));
  return null;
}

/** Parse the employee report in memory. Diagnostics contain row/field metadata, never personal values. */
export function parseEmployeeReport(workbook) {
  const report = { records: [], total_rows: 0, active_rows: 0, skipped_rows: 0, warnings: [], errors: [] };
  const issue = (kind, row, field, message) => report[kind].push({ row, field, message });
  let sheet;
  let columns;
  for (const candidate of workbook.worksheets) {
    const headers = new Map();
    candidate.getRow(1).eachCell((cell, index) => headers.set(normalizeHeader(textOf(cell)), index));
    if (headers.has(normalizeHeader(HEADERS.code)) && headers.has(normalizeHeader(HEADERS.status))) {
      sheet = candidate;
      columns = Object.fromEntries(Object.entries(HEADERS).map(([field, header]) => [field, headers.get(normalizeHeader(header))]));
      break;
    }
  }
  if (!sheet) {
    issue('errors', 1, 'headers', 'Employee report headers were not found.');
    return report;
  }
  for (const field of ['code', 'name', 'joined_on', 'status', 'pf_details_available', 'esi_enabled', 'pt_state']) {
    if (!columns[field]) issue('errors', 1, field, 'Required report column is missing.');
  }
  if (report.errors.length) return report;

  const seen = new Set();
  const dateOptions = { date1904: Boolean(workbook.properties.date1904) };
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1 || !row.values.some((value) => supplied(String(scalar(value) ?? '').trim()))) return;
    report.total_rows += 1;
    const cell = (field) => columns[field] ? row.getCell(columns[field]) : undefined;
    const text = (field, identifier = false) => supplied(textOf(cell(field), identifier));
    if (text('status').toLowerCase() !== 'working') {
      report.skipped_rows += 1;
      return;
    }
    report.active_rows += 1;
    const errorCount = report.errors.length;
    const warn = (field, message) => issue('warnings', rowNumber, field, message);
    const error = (field, message) => issue('errors', rowNumber, field, message);
    const code = text('code', true);
    const name = text('name');
    if (!code) error('code', 'Active employee code is required.');
    else {
      const key = code.toUpperCase();
      if (seen.has(key)) error('code', 'Duplicate active employee code.');
      seen.add(key);
      if (companyOf(code) !== 'AJ') error('code', 'Employee code does not belong to AJ Power.');
    }
    if (!employeeCoreSchema.shape.name.safeParse(name).success) error('name', 'Active employee name is required and must fit the supported length.');
    const joined_on = normalizeReportDate(cell('joined_on')?.value, dateOptions);
    if (!joined_on) error('joined_on', 'A valid joining date is required.');

    let department = text('department');
    if (!department) { department = 'Unassigned'; warn('department', 'Missing department; using Unassigned.'); }
    let designation = text('designation');
    if (!designation) { designation = 'Not provided'; warn('designation', 'Missing designation; using Not provided.'); }
    if (!employeeCoreSchema.shape.designation.safeParse(designation).success) error('designation', 'Designation exceeds the supported length.');

    const sourceGender = text('gender').toUpperCase();
    const gender = ({ M: 'MALE', MALE: 'MALE', F: 'FEMALE', FEMALE: 'FEMALE', OTHER: 'OTHER' })[sourceGender] ?? 'OTHER';
    if (!sourceGender || !['M', 'MALE', 'F', 'FEMALE', 'OTHER'].includes(sourceGender)) warn('gender', 'Missing or unsupported gender; using OTHER.');
    let phone = text('phone', true);
    if (!phone || !employeeCoreSchema.shape.phone.safeParse(phone).success) {
      phone = '';
      warn('phone', 'Missing or invalid phone; leaving blank.');
    }
    const optionalCore = (field, value) => {
      if (!value) return null;
      if (employeeCoreSchema.shape[field].safeParse(value).success) return value;
      warn(field, 'Invalid optional field; leaving blank.');
      return null;
    };
    const email = optionalCore('email', text('corporate_email') || text('personal_email'));
    const address = optionalCore('address', text('address'));

    const identity = {};
    for (const field of Object.keys(employeeIdentitySchema.shape)) {
      const raw = scalar(cell(field)?.value);
      let value = text(field, true);
      if (['pan', 'bank_ifsc'].includes(field)) value = value.toUpperCase().replace(/\s+/g, '');
      if (['aadhaar', 'uan', 'esi_number', 'bank_account'].includes(field)) value = value.replace(/\s+/g, '');
      if (typeof raw === 'number' && !Number.isSafeInteger(raw)) {
        warn(field, 'Numeric identifier cannot be represented exactly; leaving blank.');
        value = '';
      } else if (value && !employeeIdentitySchema.shape[field].safeParse(value).success) {
        warn(field, 'Invalid optional identifier; leaving blank.');
        value = '';
      }
      identity[field] = value || null;
    }

    const dateOfBirth = (field) => {
      if (!text(field) && scalar(cell(field)?.value) == null) return null;
      const raw = scalar(cell(field)?.value);
      if (typeof raw === 'string' && !supplied(raw.trim())) return null;
      const parsed = normalizeReportDate(raw, dateOptions);
      if (!parsed) warn(field, 'Invalid optional birth date; leaving blank.');
      return parsed;
    };
    const panDob = dateOfBirth('pan_dob');
    const aadhaarDob = dateOfBirth('aadhaar_dob');
    let dob = panDob || aadhaarDob;
    if (panDob && aadhaarDob && panDob !== aadhaarDob) {
      dob = null;
      warn('dob', 'Birth dates in the identity fields disagree; leaving blank for review.');
    }

    const eligibility = (field) => {
      const value = text(field).toLowerCase();
      if (value === 'yes') return true;
      if (value === 'no') return false;
      error(field, 'Report flag must be explicitly Yes or No.');
      return null;
    };
    // This column reports document availability, not statutory PF participation.
    const pf_details_available = eligibility('pf_details_available');
    const pf_enabled = true;
    if (pf_details_available === false) {
      warn('pf_details_available', 'PF details are unavailable; application PF default retained pending participation review.');
    }
    const esi_enabled = eligibility('esi_enabled');
    const pt_state = text('pt_state');
    if (!pt_state) error('pt_state', 'Professional tax state is required.');
    if (report.errors.length === errorCount) {
      report.records.push({ source_row: rowNumber, code, name, status: 'ACTIVE', joined_on, gender, phone, email, pf_details_available,
        address, dob, department, designation, identity, statutory: { pf_enabled, esi_enabled, pt_state } });
    }
  });
  return report;
}

/** Accept a file path, XLSX buffer, or ExcelJS Workbook; never write the source report. */
export async function readEmployeeReport(file) {
  if (file instanceof ExcelJS.Workbook) return parseEmployeeReport(file);
  const workbook = new ExcelJS.Workbook();
  if (typeof file === 'string') await workbook.xlsx.readFile(file);
  else await workbook.xlsx.load(file);
  return parseEmployeeReport(workbook);
}
