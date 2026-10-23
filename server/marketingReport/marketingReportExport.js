'use strict';

// Xuat bang cua tab Quan ly Marketing ra Excel / HTML (hop thoai "Xuat file" dung chung cua tab Bao cao).
// Moi muc (BC thang, Check ty le nhan so, Sao luu SDT, Bao cao chi phi) co 2 bang: summary (Tong quan)
// va rows (Du lieu chi tiet); cot khop dung cot dang hien tren man hinh.

const ExcelJS = require('exceljs');
const { HEADER_FONT, frozenNoGridlinesView, applyFullTableBorder } = require('../excelTableStyle');
const fuzzy = require('../shared/fuzzySearch');
const { renderHtmlReport } = require('../dashboard/exportHtmlReport');

const MAX_EXPORT_ROWS = 20000;
const KIND_TITLES = { monthly: 'BC tháng', 'receipt-check': 'Check tỷ lệ nhận số', phones: 'Sao lưu SĐT', costs: 'Báo cáo chi phí' };
const TABLE_TITLES = { summary: 'Tổng quan', rows: 'Dữ liệu chi tiết' };

const ROW_COLUMNS = {
  monthly: [['sale', 'Sale'], ['customer', 'Khách Kiot'], ['phone', 'SĐT'], ['page', 'Page'], ['status', 'Tình trạng'], ['dataSource', 'Nguồn data'], ['closedAt', 'Ngày chốt'], ['revenue', 'Doanh số', 'number'], ['newCustomer', 'Khách mới'], ['note', 'Ghi chú']],
  'receipt-check': [['name', 'Nhân viên'], ['page', 'Page'], ['first', 'Lần đầu', 'number'], ['repeat', 'Chào lại', 'number'], ['equivalent', 'Quy đổi', 'number'], ['closed', 'Khách chốt', 'number'], ['rate', 'Tỷ lệ chốt', 'percent']],
  phones: [['phone', 'SĐT'], ['page', 'Page'], ['firstEmployee', 'Nhân viên lần đầu'], ['currentEmployee', 'Nhân viên hiện tại'], ['repeatEmployee', 'Nhân viên chào lại'], ['firstAt', 'Ngày lần đầu'], ['currentAt', 'Ngày hiện tại'], ['repeatAt', 'Ngày chào lại']],
  costs: [['page', 'Page'], ['date', 'Ngày'], ['adCost', 'Chi phí ADS', 'number'], ['totalCost', 'Chi phí gồm phí thuê/VAT', 'number'], ['totalLabel', 'Nhãn chi phí nguồn'], ['messages', 'Mess', 'number'], ['costPerMessage', 'Chi phí/mess', 'number'], ['phones', 'SĐT', 'number'], ['costPerPhone', 'Chi phí/SĐT', 'number']]
};
const SUMMARY_COLUMNS = [['label', 'Đối tượng'], ['page', 'Page'], ['employee', 'Nhân viên'], ['count', 'Số dòng', 'number'], ['revenue', 'Doanh số', 'number'], ['first', 'Lần đầu', 'number'], ['repeat', 'Chào lại', 'number'], ['equivalent', 'Quy đổi', 'number'], ['closed', 'Khách chốt', 'number'], ['rate', 'Tỷ lệ chốt', 'percent'], ['totalCost', 'Tổng chi phí', 'number'], ['messages', 'Mess', 'number'], ['phones', 'SĐT', 'number']];

function invalid(message, code) {
  const e = new Error(message);
  e.statusCode = 400;
  e.code = code || 'MARKETING_EXPORT_INVALID';
  return e;
}

function check(kind, table) {
  if (!KIND_TITLES[kind]) throw invalid('Mục báo cáo không hợp lệ.');
  if (!TABLE_TITLES[table]) throw invalid('Bảng xuất không hợp lệ.');
}

function tableRows(table, result, q, sort = {}) {
  const rows = table === 'summary' ? result.summaryRows || [] : result.rows || [];
  // Tim gan dung cung luat voi bang tren man hinh (marketing-report.js): bo dau, nhieu tu, khop nhieu tu xep truoc.
  const found = String(q || '').trim() ? fuzzy.filter(rows, q, row => Object.values(row).join(' ')) : rows;
  // Sap xep theo cot dang bam tren man hinh (cung quy tac so sanh voi draw() cua marketing-report.js).
  const key = typeof sort.sortKey === 'string' ? sort.sortKey : '';
  if (!key || !['asc', 'desc'].includes(sort.sortDir)) return found;
  const direction = sort.sortDir === 'asc' ? 1 : -1;
  return found.slice().sort((a, b) => {
    const av = a[key], bv = b[key];
    if (av == null) return 1;
    if (bv == null) return -1;
    return direction * (typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), 'vi', { numeric: true }));
  });
}

function columnsFor(kind, table, result) {
  const source = table === 'summary'
    ? SUMMARY_COLUMNS.filter(([key]) => key === 'label' || (result.summaryRows || []).some(row => row[key] !== undefined))
    : ROW_COLUMNS[kind];
  return source.map(([key, label, type]) => ({ key, label, type: type || 'text' }));
}

function exportFieldsFor(kind, table, result, rows) {
  check(kind, table);
  return {
    title: `Marketing · ${KIND_TITLES[kind]} · ${TABLE_TITLES[table]}`,
    selectionMode: 'custom',
    worksheets: [{
      key: table,
      name: TABLE_TITLES[table],
      rowCount: rows.length,
      fields: columnsFor(kind, table, result).map(({ key, label, type }) => ({ key, label, type, selected: true }))
    }]
  };
}

// columns = "a,b,c" (whitelist theo bang; sai / rong => 400); khong truyen = tat ca cot.
function resolveColumnKeys(kind, table, result, param) {
  if (param === undefined || param === null) return null;
  const bad = () => invalid('Danh sách trường xuất không hợp lệ.', 'MARKETING_EXPORT_COLUMNS');
  const parts = Array.isArray(param) ? param : typeof param === 'string' ? [param] : null;
  if (!parts || parts.some(p => typeof p !== 'string')) throw bad();
  const requested = new Set(parts.join(',').split(',').map(s => s.trim()).filter(Boolean));
  if (!requested.size) throw bad();
  const allowed = columnsFor(kind, table, result).map(c => c.key);
  for (const key of requested) if (!allowed.includes(key)) throw bad();
  return allowed.filter(key => requested.has(key));
}

function safeText(value) {
  const text = String(value == null ? '' : value);
  return /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
}

function cell(row, column) {
  const v = row[column.key];
  if (column.type === 'number' || column.type === 'percent') {
    return v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? '' : Number(v);
  }
  return v === null || v === undefined || (typeof v === 'string' && v.startsWith('#')) ? '' : String(v);
}

async function createExportFile(kind, table, format, result, rows, columnKeys) {
  check(kind, table);
  if (!['xlsx', 'html'].includes(format)) throw invalid('Định dạng xuất không hợp lệ.');
  if (rows.length > MAX_EXPORT_ROWS) throw invalid('Dữ liệu vượt giới hạn 20.000 dòng mỗi lần xuất. Hãy thu hẹp bộ lọc rồi xuất lại.', 'MARKETING_EXPORT_TOO_MANY_ROWS');
  const all = columnsFor(kind, table, result);
  const columns = columnKeys ? all.filter(c => columnKeys.includes(c.key)) : all;
  const fileBase = `TKS_Marketing_${kind.replace(/-/g, '_')}_${table}`;
  const title = `Marketing · ${KIND_TITLES[kind]} · ${TABLE_TITLES[table]}`;
  const provenance=[['Tập dữ liệu',result.dataset||result.sourceMode||'sheets'],['Snapshot',result.snapshotId||''],['Tính lúc',result.computedAt||''],...Object.entries(result.sources||{}).map(([key,value])=>[key,typeof value==='string'?value:JSON.stringify(value)]),...(result.warnings||[]).map(w=>['Ghi chú',w])];
  if (format === 'html') {
    return renderHtmlReport({
      meta: { title, reportNotes:provenance, branch: 'Hà Nội + Sài Gòn', generatedAt: result.computedAt ? new Date(result.computedAt) : new Date(), fileBase },
      worksheets: [{
        key: table,
        name: TABLE_TITLES[table],
        columns: columns.map(({ key, label, type }) => ({ key, label, type: type === 'text' ? 'general' : type })),
        rows: rows.map(row => Object.fromEntries(columns.map(c => [c.key, cell(row, c)])))
      },{key:'provenance',name:'Nguồn và trạng thái',columns:[{key:'label',label:'Mục',type:'general'},{key:'value',label:'Nội dung',type:'general'}],rows:provenance.map(([label,value])=>({label,value}))}]
    });
  }
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TOKOSI Dashboard';
  const sheet = workbook.addWorksheet(TABLE_TITLES[table]);
  sheet.columns = columns.map(c => ({
    key: c.key,
    header: c.label,
    width: c.type === 'number' ? 18 : c.type === 'percent' ? 14 : 28,
    style: c.type === 'number' ? { numFmt: '#,##0.##' } : c.type === 'percent' ? { numFmt: '0.0%' } : {}
  }));
  for (const row of rows) {
    sheet.addRow(columns.map(c => {
      const v = cell(row, c);
      return typeof v === 'string' ? safeText(v) : v;
    }));
  }
  sheet.views = frozenNoGridlinesView(1);
  sheet.getRow(1).font = HEADER_FONT;
  sheet.getRow(1).height = 24;
  sheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, rows.length + 1), column: columns.length } };
  applyFullTableBorder(sheet, columns.length, rows.length + 1);
  const sourceSheet=workbook.addWorksheet('Nguồn và trạng thái');
  sourceSheet.columns=[{header:'Mục',width:24},{header:'Nội dung',width:100}];
  for(const pair of provenance)sourceSheet.addRow(pair.map(safeText));
  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    fileName: `${fileBase}.xlsx`
  };
}

module.exports = { createExportFile, tableRows, exportFieldsFor, resolveColumnKeys, MAX_EXPORT_ROWS };
