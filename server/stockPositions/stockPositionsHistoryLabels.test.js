'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ACTION_LABELS, summaryText } = require('./stockPositionsHistoryLabels');

test('nhãn + tóm tắt cho ack / unack / history_purged', () => {
  assert.equal(ACTION_LABELS.ack, 'Đánh dấu Đã sửa');
  assert.equal(ACTION_LABELS.unack, 'Bỏ Đã sửa');
  assert.equal(ACTION_LABELS.history_purged, 'Xóa lịch sử');
  assert.equal(summaryText({ warnings: ['unreadable', 'unknowncode'] }), 'Sai định dạng, Mã SP lạ');
  assert.equal(summaryText({ deleted: 5, from: '2026-10-01', to: '2026-10-05' }), 'Xóa 5 · 01/10/2026 – 05/10/2026');
  assert.equal(summaryText({ deleted: 5, from: '2026-10-01', to: null }), 'Xóa 5 · từ 01/10/2026');
  assert.equal(summaryText({ deleted: 5, from: null, to: '2026-10-05' }), 'Xóa 5 · đến 05/10/2026');
  assert.equal(summaryText({ deleted: 5, from: null, to: null }), 'Xóa 5 · toàn bộ');
});

test('tóm tắt bỏ Đã sửa (warnings rỗng) không rỗng; tóm tắt nhặt hàng đọc được', () => {
  assert.equal(summaryText({ warnings: [] }), 'Không có cảnh báo');
  assert.equal(summaryText({ orderCode: 'DH1', assignmentId: 7, confirmedBy: 'Hà', picked: 12 }), 'Nhặt 12 · Xác nhận: Hà');
  assert.equal(summaryText({ orderCode: 'DH2', assignmentId: 8, confirmedBy: '', picked: 5 }), 'Nhặt 5 · Job Kiot');
  assert.equal(summaryText({ warnings: ['unreadable'] }), 'Sai định dạng');
});

test('tóm tắt thao tác từ hộp Chỉ định vị trí: nêu mã đơn, giữ phần tóm tắt khác', () => {
  assert.equal(summaryText({ source: 'pick', orderCode: 'DH001' }), 'Chỉ định đơn DH001');
  assert.equal(summaryText({ merged: true, added: '1T x 50', source: 'pick', orderCode: 'DH001' }), 'Chỉ định đơn DH001 · Thêm 1T x 50');
  assert.equal(summaryText({ notes: '1T x 5', arrivalDate: '', location: 'A1', source: 'pick', orderCode: 'DH2' }), 'Chỉ định đơn DH2');
  // Nhặt hàng theo đơn (confirm) cũng có orderCode nhưng không có source: giữ tóm tắt cũ.
  assert.equal(summaryText({ orderCode: 'DH1', assignmentId: 7, confirmedBy: 'Hà', picked: 12 }), 'Nhặt 12 · Xác nhận: Hà');
});

test('nhãn + tóm tắt Xuất kho (stock_out); Trừ SL cũ cũng đọc được', () => {
  assert.equal(ACTION_LABELS.stock_out, 'Xuất kho');
  assert.equal(summaryText({ deducted: 250, removed: false, fileName: 'xuat.xlsx', fileRows: [2, 3] }), 'Trừ 250 · xuat.xlsx');
  assert.equal(summaryText({ deducted: 100, removed: true, fileName: 'xuat.xlsx', fileRows: [2] }), 'Trừ 100 · Hết hàng, đã xóa dòng · xuat.xlsx');
  assert.equal(summaryText({ deducted: 200 }), 'Trừ 200');
});
