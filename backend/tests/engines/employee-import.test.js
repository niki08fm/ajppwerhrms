import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { normalizeReportDate, parseEmployeeReport, readEmployeeReport } from '../../src/services/employee-import.service.js';

const FIELDS = {
  code: 'Employee Number', name: 'Employee Name', joined_on: 'Joining Date', status: 'Employment Status',
  department: 'Department', designation: 'Job Title', pan: 'Pan Number', aadhaar: 'Aadhaar Card Number',
  uan: 'UAN', esi_number: 'ESI Number', bank_account: 'Account Number', bank_ifsc: 'IFSC Code',
  bank_name: 'Bank Name', pan_dob: 'Date of Birth on PAN', aadhaar_dob: 'Date of Birth on AADHAAR',
  gender: 'Gender on Aadhaar', phone: 'Phone', corporate_email: 'Tulfa Mail ', personal_email: 'Personal Email',
  address: 'Address on Aadhaar', pf_details_available: 'PF Details Available', esi_enabled: 'ESI Eligible', pt_state: 'PT State',
};

function workbook(rows, { date1904 = false } = {}) {
  const book = new ExcelJS.Workbook();
  book.properties.date1904 = date1904;
  const sheet = book.addWorksheet('Employee Data');
  sheet.addRow(Object.values(FIELDS));
  for (const [index, input] of rows.entries()) {
    const data = {
      code: `TI${String(index + 1).padStart(3, '0')}`, name: `Example Employee ${index + 1}`,
      joined_on: '2024-02-29', status: 'Working', department: 'Operations', designation: 'Coordinator',
      gender: 'Female', phone: '9000000000', corporate_email: 'example@example.test',
      pf_details_available: 'Yes', esi_enabled: 'No', pt_state: 'Telangana', ...input,
    };
    sheet.addRow(Object.keys(FIELDS).map((field) => data[field] ?? null));
  }
  return book;
}

function cell(book, row, field) {
  return book.worksheets[0].getCell(row, Object.keys(FIELDS).indexOf(field) + 1);
}

describe('active employee report import', () => {
  it('imports only working rows and skips relieved, blank status, and incomplete trailing rows', () => {
    const report = parseEmployeeReport(workbook([
      {}, { status: 'Relieved' }, { status: '' },
      { code: '', name: '', joined_on: '', status: '', department: 'Operations' },
    ]));
    expect(report.total_rows).toBe(4);
    expect(report.active_rows).toBe(1);
    expect(report.skipped_rows).toBe(3);
    expect(report.errors).toEqual([]);
    expect(report.records).toHaveLength(1);
    expect(report.records[0]).toMatchObject({ source_row: 2, code: 'TI001', status: 'ACTIVE', joined_on: '2024-02-29' });
  });

  it('flags duplicate active source codes without renumbering employees or reporting their values', () => {
    const report = parseEmployeeReport(workbook([{ code: 'TI099' }, { code: 'ti099' }, { code: 'TI099', status: 'Relieved' }]));
    expect(report.errors).toEqual([{ row: 3, field: 'code', message: 'Duplicate active employee code.' }]);
    expect(report.records).toHaveLength(1);
    expect(report.records[0].code).toBe('TI099');
    expect(JSON.stringify(report.errors)).not.toContain('TI099');
  });

  it('rejects Techpi codes instead of silently creating employees in the wrong company', () => {
    const report = parseEmployeeReport(workbook([{ code: 'TP001' }]));
    expect(report.errors).toContainEqual({ row: 2, field: 'code', message: 'Employee code does not belong to AJ Power.' });
    expect(report.records).toEqual([]);
  });

  it('requires a source code, name, and valid joining date for active records', () => {
    const report = parseEmployeeReport(workbook([{ code: '', name: '', joined_on: '31/02/2024' }]));
    expect(report.errors.map(({ field }) => field)).toEqual(['code', 'name', 'joined_on']);
    expect(report.records).toEqual([]);
  });

  it('preserves string identifiers and their leading zeros, including zero-formatted numeric cells', async () => {
    const book = workbook([{
      aadhaar: '0123 4567 8901', uan: '001234567890', esi_number: '0012345678',
      bank_account: '0001234567', pan: 'abcde1234f', bank_ifsc: 'abcd0001234', bank_name: 'Example Bank',
    }, { bank_account: 123456 }]);
    cell(book, 3, 'bank_account').numFmt = '0000000000';
    const report = await readEmployeeReport(await book.xlsx.writeBuffer());
    expect(report.errors).toEqual([]);
    expect(report.records[0].identity).toEqual({
      pan: 'ABCDE1234F', aadhaar: '012345678901', uan: '001234567890', esi_number: '0012345678',
      bank_account: '0001234567', bank_ifsc: 'ABCD0001234', bank_name: 'Example Bank',
    });
    expect(report.records[1].identity.bank_account).toBe('0000123456');
  });

  it('records explicit defaults for missing department, designation, phone, and gender', () => {
    const report = parseEmployeeReport(workbook([{
      department: 'N/A', designation: '-', phone: 'Not available', gender: '',
      pan: 'nil', aadhaar: 'NA', bank_account: 'Not provided', pan_dob: 'N/A',
    }]));
    expect(report.records[0]).toMatchObject({ department: 'Unassigned', designation: 'Not provided', phone: '', gender: 'OTHER', dob: null });
    expect(Object.values(report.records[0].identity)).toEqual(Array(7).fill(null));
    expect(report.warnings.map(({ field }) => field)).toEqual(['department', 'designation', 'gender', 'phone']);
    expect(report.errors).toEqual([]);
  });

  it('clears a conflicting birth date rather than selecting either identity document', () => {
    const report = parseEmployeeReport(workbook([{ pan_dob: '01 Jan 1990', aadhaar_dob: '02/01/1990' }]));
    expect(report.records[0].dob).toBeNull();
    expect(report.warnings).toContainEqual({ row: 2, field: 'dob', message: 'Birth dates in the identity fields disagree; leaving blank for review.' });
  });

  it('uses a supplied birth date from either document when the other is absent', () => {
    const report = parseEmployeeReport(workbook([{ pan_dob: '01 Jan 1990' }, { aadhaar_dob: new Date('1990-01-02T00:00:00.000Z') }]));
    expect(report.records.map(({ dob }) => dob)).toEqual(['1990-01-01', '1990-01-02']);
  });

  it('drops invalid optional identities individually and keeps valid fields', () => {
    const report = parseEmployeeReport(workbook([{
      pan: 'invalid', aadhaar: '1234', bank_account: '123', bank_ifsc: 'invalid', uan: '001234567890',
    }]));
    expect(report.errors).toEqual([]);
    expect(report.records[0].identity).toMatchObject({ pan: null, aadhaar: null, bank_account: null, bank_ifsc: null, uan: '001234567890' });
    expect(report.warnings.map(({ field }) => field)).toEqual(['pan', 'aadhaar', 'bank_account', 'bank_ifsc']);
    expect(JSON.stringify(report.warnings)).not.toContain('1234');
  });

  it('does not round an unsafe numeric identifier into a different account', () => {
    const report = parseEmployeeReport(workbook([{ bank_account: Number.MAX_SAFE_INTEGER + 1 }]));
    expect(report.records[0].identity.bank_account).toBeNull();
    expect(report.warnings.some(({ field }) => field === 'bank_account')).toBe(true);
  });

  it('keeps PF document availability separate from participation and reads explicit ESI eligibility', () => {
    const report = parseEmployeeReport(workbook([{ pf_details_available: 'No', esi_enabled: 'Yes' }, { pf_details_available: '', esi_enabled: 'Unknown' }]));
    expect(report.records[0].pf_details_available).toBe(false);
    expect(report.records[0].statutory).toEqual({ pf_enabled: true, esi_enabled: true, pt_state: 'Telangana' });
    expect(report.warnings).toContainEqual({
      row: 2, field: 'pf_details_available',
      message: 'PF details are unavailable; application PF default retained pending participation review.',
    });
    expect(report.errors.map(({ field }) => field)).toEqual(['pf_details_available', 'esi_enabled']);
    expect(report.records).toHaveLength(1);
  });

  it('keeps supplied email addresses and falls back to personal email only when corporate email is absent', () => {
    const report = parseEmployeeReport(workbook([
      { corporate_email: 'office@example.test', personal_email: 'personal@example.test' },
      { corporate_email: 'N/A', personal_email: 'personal@example.test' },
    ]));
    expect(report.records.map(({ email }) => email)).toEqual(['office@example.test', 'personal@example.test']);
  });

  it('uses cached formulas, rich text, and hyperlink labels as text without following links', () => {
    const report = parseEmployeeReport(workbook([{
      name: { richText: [{ text: 'Example ' }, { text: 'Employee' }] },
      department: { formula: '"Operations"', result: 'Operations' },
      corporate_email: { text: 'contact@example.test', hyperlink: 'https://example.test/untrusted' },
      joined_on: { formula: 'DATE(2024,2,29)', result: 45351 },
    }]));
    expect(report.errors).toEqual([]);
    expect(report.records[0]).toMatchObject({ name: 'Example Employee', department: 'Operations', email: 'contact@example.test', joined_on: '2024-02-29' });
  });

  it('rejects a workbook without the required employee report headers', () => {
    const report = parseEmployeeReport(new ExcelJS.Workbook());
    expect(report.errors).toEqual([{ row: 1, field: 'headers', message: 'Employee report headers were not found.' }]);
    expect(report.records).toEqual([]);
  });
});

describe('strict UTC report date normalization', () => {
  it.each([
    ['2024-02-29', '2024-02-29'], ['29/02/2024', '2024-02-29'], ['29-02-2024', '2024-02-29'],
    ['29 Feb 2024', '2024-02-29'], [45351, '2024-02-29'], [45351.5, '2024-02-29'],
    [new Date('2024-02-29T00:00:00.000Z'), '2024-02-29'], [59, '1900-02-28'], [61, '1900-03-01'],
  ])('normalizes a supported date to UTC YYYY-MM-DD', (value, expected) => {
    expect(normalizeReportDate(value)).toBe(expected);
  });

  it.each(['2023-02-29', '31/04/2024', '2024-13-01', '01/02-2024', '02 Xxx 2024', '2024-02-31', 60, NaN, new Date(NaN)])(
    'rejects nonexistent or unsupported dates instead of allowing Date rollover', (value) => {
      expect(normalizeReportDate(value)).toBeNull();
    },
  );

  it('supports the Excel 1904 epoch explicitly', () => {
    expect(normalizeReportDate(0, { date1904: true })).toBe('1904-01-01');
    expect(parseEmployeeReport(workbook([{ joined_on: 0 }], { date1904: true })).records[0].joined_on).toBe('1904-01-01');
  });
});
