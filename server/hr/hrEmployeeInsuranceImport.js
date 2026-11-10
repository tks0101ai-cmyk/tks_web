'use strict';

const ExcelJS = require('exceljs');
const { normalizeInsuranceNumber, isNotEnrolled } = require('./hrInsuranceNumber');

function cellText(cell) {
  const value = cell && cell.value;
  if (value == null) return '';
  if (typeof value === 'object') return String(value.text || value.result || '').trim();
  return String(value).trim();
}

async function parseInsuranceWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('File Excel không có trang dữ liệu.');
  const headers = new Map();
  sheet.getRow(1).eachCell((cell, column) => headers.set(cellText(cell), column));
  const idColumn = headers.get('ID nhân sự');
  const insuranceColumn = headers.get('Số bảo hiểm');
  if (!idColumn || !insuranceColumn) throw new Error('File cần có cột ID nhân sự và Số bảo hiểm từ bản xuất Excel.');
  const rows = [];
  for (let number = 2; number <= sheet.rowCount; number += 1) {
    const row = sheet.getRow(number);
    const insuranceCell = row.getCell(insuranceColumn);
    const id = cellText(row.getCell(idColumn));
    const insuranceNumber = normalizeInsuranceNumber(cellText(insuranceCell));
    if (id || insuranceNumber) rows.push({ number, id, insuranceNumber });
  }
  return rows;
}

function previewInsuranceImport(rows, employees, branches) {
  const byId = new Map(employees.map(e => [String(e.rowIndex), e]));
  const seenIds = new Set();
  const seenNumbers = new Set();
  const existingNumbers = new Map(employees
    .filter(e => e.insuranceNumber && !isNotEnrolled(e.insuranceNumber))
    .map(e => [normalizeInsuranceNumber(e.insuranceNumber), String(e.rowIndex)]));
  const updates = [];
  const errors = [];
  for (const row of rows) {
    const insuranceNumber = normalizeInsuranceNumber(row.insuranceNumber);
    if (!insuranceNumber) continue;
    const employee = byId.get(row.id);
    let reason = '';
    if (!/^\d+$/.test(row.id) || !employee) reason = 'ID nhân sự không tồn tại';
    else if (!branches.includes(employee.sourceBranch)) reason = 'Nhân sự ngoài phạm vi cơ sở';
    else if (seenIds.has(row.id)) reason = 'ID nhân sự lặp trong file';
    else if (!isNotEnrolled(insuranceNumber) && (seenNumbers.has(insuranceNumber) || (existingNumbers.has(insuranceNumber) && existingNumbers.get(insuranceNumber) !== row.id))) reason = 'Số bảo hiểm bị trùng';
    if (reason) errors.push({ row: row.number, id: row.id, reason });
    else updates.push({ id: row.id, insuranceNumber });
    seenIds.add(row.id);
    if (!isNotEnrolled(insuranceNumber)) seenNumbers.add(insuranceNumber);
  }
  return { total: rows.length, valid: updates.length, errors, updates };
}

module.exports = { parseInsuranceWorkbook, previewInsuranceImport };
