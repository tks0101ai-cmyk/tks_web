// ==========================================
// HR EMPLOYEE EXPORT SERVICE — xuat file Excel Danh sach nhan su dang duoc
// tim kiem/loc tren trang Quan ly nhan su.
//
// Tach rieng khoi hrLeaveExportService.js vi khac schema (danh sach nhan su
// tu Google Sheet, khong phai bang leave_requests).
// ==========================================
'use strict';

const ExcelJS = require('exceljs');
const fuzzy = require('../shared/fuzzySearch');
const employeeDirectory = require('./employeeDirectory');
const { BRANCHES } = require('../branch/branches');
const { matchesDepartment } = require('./hrDepartment');
const { HEADER_FONT, frozenNoGridlinesView, applyFullTableBorder } = require('../excelTableStyle');

const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const BASE_HEADERS = ['Họ và tên', 'Chức vụ', 'Cơ sở', 'Số điện thoại', 'Email', 'Trạng thái'];
const BASE_WIDTHS = [24, 28, 12, 18, 26, 16];
const EXTENDED_HEADERS = [
  'Họ và tên', 'Bộ phận', 'Chức vụ', 'Ngày vào làm', 'Số ngày LV', 'Ngày sinh', 'Số CCCD', 'SĐT',
  'Địa chỉ hiện tại', 'Giới tính', 'Hồ sơ', 'Vân tay', 'Số bảo hiểm', 'Cơ sở', 'QH người thân', 'Họ tên người thân',
  'SĐT người thân', 'Trạng thái', 'Ngày nghỉ việc', 'Email', 'Ngày thêm', 'ID nhân sự'
];
const EXTENDED_WIDTHS = [26, 18, 24, 14, 12, 14, 16, 16, 36, 12, 11, 11, 20, 12, 18, 24, 16, 14, 14, 26, 14, 15];
const STATUS_LABELS = { active: 'Đang làm việc', resigned: 'Đã nghỉ việc' };

function formatDateVN(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(d);
  const get = type => parts.find(p => p.type === type).value;
  return `${get('day')}/${get('month')}/${get('year')}`;
}

function toDateParts(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value).split('-').map(Number);
    return parts;
  }
  const match = String(value).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function formatDateOnly(value) {
  const p = toDateParts(value);
  return p ? `${String(p[2]).padStart(2, '0')}/${String(p[1]).padStart(2, '0')}/${p[0]}` : '';
}

// So ngay lam viec = tu ngay vao lam den ngay nghi viec (neu da nghi) hoac den hom nay (gio Viet Nam).
function workingDays(startValue, endValue, now = new Date()) {
  const start = toDateParts(startValue);
  if (!start) return '';
  const end = toDateParts(endValue) || toDateParts(now);
  const days = Math.floor((Date.UTC(end[0], end[1] - 1, end[2]) - Date.UTC(start[0], start[1] - 1, start[2])) / 86400000);
  return Math.max(0, days);
}

// `branch` la 1 co so hoac danh sach co so dang xuat; chi 1 co so moi gan HN/SG.
function branchFilePrefix(branch) {
  const only = Array.isArray(branch) ? (branch.length === 1 ? branch[0] : null) : branch;
  if (only === BRANCHES.HANOI) return 'HN';
  if (only === BRANCHES.SAIGON) return 'SG';
  return 'TKS';
}

/**
 * @param {Object} filters { keyword, department } — loc theo tu khoa dang go tren o tim kiem
 *   va phong ban dang chon cua bang.
 * @param {string|string[]} branch Co so, hoac danh sach co so dang xuat.
 * @returns {Promise<{ buffer: Buffer, fileName: string, mime: string }>}
 */
async function buildEmployeeDirectoryWorkbook(filters, branch) {
  filters = filters || {};
  const includeExtended = Boolean(filters.includeExtended);
  // Nhân sự không có quyền quản lý vẫn dùng bản xuất giới hạn như trước.
  const HEADERS = includeExtended ? EXTENDED_HEADERS : (filters.includeCreatedAt ? [...BASE_HEADERS, 'Ngày thêm'] : BASE_HEADERS);
  const COLUMN_WIDTHS = includeExtended ? EXTENDED_WIDTHS : (filters.includeCreatedAt ? [...BASE_WIDTHS, 14] : BASE_WIDTHS);
  const statusFilter = filters.status === 'active' || filters.status === 'resigned' ? filters.status : '';
  const keyword = String(filters.keyword || '').trim();

  const snapshot = await employeeDirectory.getSnapshot();
  const branches = Array.isArray(branch) ? branch : [branch];
  let items = snapshot.employees
    .filter(employee => branches.includes(employee.sourceBranch))
    .filter(employee => matchesDepartment(employee.boPhan, filters.department))
    .filter(employee => !statusFilter || employee.employmentStatus === statusFilter)
    .map(employee => ({
      hoTen: employee.hoTen,
      boPhan: employee.boPhan,
      coSo: employee.sourceBranch,
      soDienThoai: employee.soDienThoai,
      email: employee.email,
      chucVu: employee.chucVu,
      ngayVaoLam: formatDateOnly(employee.ngayVaoLam),
      soNgayLamViec: workingDays(employee.ngayVaoLam, employee.ngayNghiViec),
      ngaySinh: formatDateOnly(employee.ngaySinh),
      soCccd: employee.soCccd,
      diaChiHienTai: employee.diaChiHienTai,
      gioiTinh: employee.gioiTinh,
      hoSo: employee.hoSoDayDu ? 'Đủ' : 'Thiếu',
      vanTay: employee.vanTayDaDangKy ? 'Đã đăng ký' : 'Chưa đăng ký',
      insuranceNumber: employee.insuranceNumber || '',
      id: String(employee.rowIndex),
      nguoiThanQuanHe: employee.nguoiThanQuanHe,
      nguoiThanHoTen: employee.nguoiThanHoTen,
      nguoiThanSoDienThoai: employee.nguoiThanSoDienThoai,
      trangThai: STATUS_LABELS[employee.employmentStatus] || STATUS_LABELS.active,
      ngayNghiViec: formatDateOnly(employee.ngayNghiViec),
      ngayThem: formatDateVN(employee.createdAt)
    }));

  items.sort((a, b) => a.hoTen.localeCompare(b.hoTen, 'vi'));
  if (keyword) {
    // Tim gan dung nhu bang Nhan su tren man hinh (Ho ten, Bo phan, Chuc vu, SDT); khop nhieu tu xep truoc.
    items = fuzzy.filter(items, keyword, e => [e.hoTen, e.boPhan, e.chucVu, e.soDienThoai].filter(Boolean).join(' '));
  }

  let requestedOrder;
  try { requestedOrder=JSON.parse(filters.orderedIds || 'null'); } catch {}
  if (Array.isArray(requestedOrder) && requestedOrder.length) { const order=new Map(requestedOrder.map((id,index)=>[String(id),index])); items.sort((a,b)=>(order.get(String(a.id))??Infinity)-(order.get(String(b.id))??Infinity)); }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TOKOSI Dashboard';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('Danh sách nhân sự');

  sheet.columns = HEADERS.map((header, i) => ({ header, key: `c${i}`, width: COLUMN_WIDTHS[i] || 18 }));

  items.forEach(item => {
    if (includeExtended) {
      sheet.addRow([
        item.hoTen, item.boPhan, item.chucVu, item.ngayVaoLam, item.soNgayLamViec, item.ngaySinh, item.soCccd,
        item.soDienThoai, item.diaChiHienTai, item.gioiTinh, item.hoSo, item.vanTay, item.insuranceNumber, item.coSo,
        item.nguoiThanQuanHe, item.nguoiThanHoTen, item.nguoiThanSoDienThoai, item.trangThai,
        item.ngayNghiViec, item.email, item.ngayThem, item.id
      ]);
    } else sheet.addRow({ c0: item.hoTen, c1: item.boPhan, c2: item.coSo, c3: item.soDienThoai, c4: item.email, c5: item.trangThai, c6: item.ngayThem });
  });

  if (includeExtended) {
    const insuranceColumn = HEADERS.indexOf('Số bảo hiểm') + 1;
    const idColumn = HEADERS.indexOf('ID nhân sự') + 1;
    sheet.getColumn(insuranceColumn).numFmt = '@';
    sheet.getColumn(idColumn).numFmt = '@';
  }

  sheet.views = frozenNoGridlinesView(1);
  sheet.getRow(1).font = HEADER_FONT;
  sheet.getRow(1).alignment = { vertical: 'middle' };
  applyFullTableBorder(sheet, HEADERS.length, items.length + 1);

  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: HEADERS.length } };

  const buffer = await workbook.xlsx.writeBuffer();
  const fileName = `${branchFilePrefix(branch)}_danh-sach-nhan-su.xlsx`;

  return { buffer, fileName, mime: EXCEL_MIME };
}

module.exports = { workingDays, buildEmployeeDirectoryWorkbook };
