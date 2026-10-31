'use strict';

// Nhan tieng Viet cua lich su VT Ha Noi / VT Sai Gon, dung chung cho loc tu khoa va xuat Excel (khop public/vt-positions/vt-positions.js).
const ACTION_LABELS = Object.freeze({
  seed: 'Nhập dữ liệu đầu', create: 'Thêm dòng', edit: 'Sửa', delete: 'Xóa dòng', auto_delete: 'Tự xóa (hết hàng)',
  deduct: 'Trừ SL', import_replace: 'Import thay toàn bộ', import_add: 'Import bổ sung',
  // Nhat hang theo don (Vong doi don hang, migration 0096): tru thung khi Xac nhan nhat / hoan tac khi Huy nhat.
  pick: 'Nhặt hàng theo đơn', pick_revert: 'Hoàn tác nhặt hàng',
  // 2026-10-28: co Da sua + dau vet xoa lich su (migration 0099).
  ack: 'Đánh dấu Đã sửa', unack: 'Bỏ Đã sửa', history_purged: 'Xóa lịch sử',
  // 2026-10-30: Xuất kho từ file (migration 0101).
  stock_out: 'Xuất kho'
});
const FIELD_LABELS = Object.freeze({ code: 'Mã hàng', name: 'Tên hàng', notes: 'Ghi chú', arrivalDate: 'Ngày về', location: 'Vị trí', quantity: 'Số lượng' });
const SUMMARY_KEYS = Object.freeze([['added', 'Thêm'], ['updated', 'Đổi'], ['deleted', 'Xóa'], ['skippedEmpty', 'Bỏ qua']]);
const WARNING_LABELS = Object.freeze({ multi: 'Nhiều quy cách', loose: 'Trừ lẻ', unreadable: 'Sai định dạng', badnumber: 'Số thùng sai', unknowncode: 'Mã SP lạ' });
const vnDate = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

// Tom tat dong import (cot "Tom tat"): "Them 3 · Doi 1 · 12 dong · file.xlsx".
function summaryText(summary) {
  if (!summary || typeof summary !== 'object') return '';
  const parts = [];
  for (const [key, label] of SUMMARY_KEYS) if (summary[key] !== undefined) parts.push(`${label} ${summary[key]}`);
  if (summary.rows !== undefined) parts.push(`${summary.rows} dòng`);
  if ('from' in summary || 'to' in summary) {
    parts.push(summary.from && summary.to ? `${vnDate(summary.from)} – ${vnDate(summary.to)}` : summary.from ? `từ ${vnDate(summary.from)}` : summary.to ? `đến ${vnDate(summary.to)}` : 'toàn bộ');
  }
  if (Array.isArray(summary.warnings) && summary.warnings.length) parts.push(summary.warnings.map(code => WARNING_LABELS[code] || code).join(', '));
  if (Array.isArray(summary.warnings) && typeof summary.notes === 'string' && summary.notes.trim()) parts.push(`Ghi chú: ${summary.notes.trim()}`);
  if (summary.deducted !== undefined) parts.push(`Trừ ${summary.deducted}`);
  if (summary.removed === true) parts.push('Hết hàng, đã xóa dòng');
  if (summary.picked !== undefined) parts.push(`Nhặt ${summary.picked}`);
  if ('confirmedBy' in summary) parts.push(summary.confirmedBy ? `Xác nhận: ${summary.confirmedBy}` : 'Job Kiot');
  if (summary.fileName) parts.push(summary.fileName);
  if (!parts.length && Array.isArray(summary.warnings)) return 'Không có cảnh báo';
  return parts.length ? parts.join(' · ') : JSON.stringify(summary);
}

module.exports = { ACTION_LABELS, FIELD_LABELS, summaryText };
