'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const q = require('./orderLifecycleQuery');

function row(code, extra = {}) {
  return {
    orderCode: code, branch: 'HN', saleName: 'Sale A', customerName: 'KH A', saleSentAt: '',
    summary: { code: 'NOT_SENT', label: 'Đơn chưa gửi kế toán', at: null }, warning: false,
    source: 'kiotviet', kiotStatus: 'Phiếu tạm', sellableValue: 100, orderTotal: 200, orderDate: '01/10/2026 10:00', note: '',
    ...extra
  };
}
const codes = rows => rows.map(r => r.orderCode);

// ---------------------------------------------------------------------------
// Chuan hoa / doc thoi gian
// ---------------------------------------------------------------------------

test('normalizeSearchText: bỏ dấu tiếng Việt (kể cả đ/Đ), chữ thường, trim', () => {
  assert.equal(q.normalizeSearchText('  Nguyễn Đức Ánh '), 'nguyen duc anh');
  assert.equal(q.normalizeSearchText(null), '');
});

test('parseDateTimeValue: dd/MM/yyyy[ HH:mm[:ss]] (kể cả lỗi gõ "15,35"), YYYY-MM-DD[ HH:mm:ss]; rỗng/sai -> null; không phụ thuộc múi giờ', () => {
  assert.equal(q.parseDateTimeValue('30/09/2026'), Date.UTC(2026, 8, 30));
  assert.equal(q.parseDateTimeValue('30/09/2026 10:47'), Date.UTC(2026, 8, 30, 10, 47));
  assert.equal(q.parseDateTimeValue('30/09/2026 15,35'), Date.UTC(2026, 8, 30, 15, 35));
  assert.equal(q.parseDateTimeValue('2026-09-30 10:47:05'), Date.UTC(2026, 8, 30, 10, 47, 5));
  assert.equal(q.parseDateTimeValue('2026-09-30'), Date.UTC(2026, 8, 30));
  assert.equal(q.parseDateTimeValue(''), null);
  assert.equal(q.parseDateTimeValue('hôm qua'), null);
  assert.equal(q.parseDateTimeValue(undefined), null);
});

// ---------------------------------------------------------------------------
// parseParams
// ---------------------------------------------------------------------------

test('parseParams: mặc định — mọi cơ sở, không lọc, sắp theo thời gian đặt hàng mới nhất trước, trang 1 x 100 dòng', () => {
  assert.deepEqual(q.parseParams({}), {
    branch: '', status: '', kiotStatus: '', warning: '', pickStatus: '', dateField: 'saleSentAt', from: '', to: '', mode: 'code', q: '',
    sort: 'orderDate', sortExplicit: false, dir: -1, page: 1, pageSize: 100
  });
  assert.deepEqual(q.parseParams(undefined).sort, 'orderDate');
});

test('parseParams: pickStatus (Chi dinh vi tri) chi nhan picking | confirmed | cancelled | none (Chua boc), gia tri la -> 400 INVALID_PICK_STATUS', () => {
  for (const status of ['picking', 'confirmed', 'cancelled', 'none']) assert.equal(q.parseParams({ pickStatus: status }).pickStatus, status);
  assert.equal(q.parseParams({ pickStatus: '' }).pickStatus, '');
  assert.deepEqual(q.PICK_STATUSES, ['picking', 'confirmed', 'cancelled', 'none']);
  assert.throws(() => q.parseParams({ pickStatus: 'done' }), { statusCode: 400, code: 'INVALID_PICK_STATUS' });
});

test('parseParams: sắp xếp — chọn cột mà không có chiều thì tăng dần; có dir thì theo dir; dir không đi kèm cột đổi chiều của mặc định', () => {
  assert.deepEqual([q.parseParams({ sort: 'orderCode' }).sort, q.parseParams({ sort: 'orderCode' }).dir], ['orderCode', 1]);
  assert.equal(q.parseParams({ sort: 'note', dir: 'desc' }).dir, -1);
  assert.equal(q.parseParams({ sort: 'note', dir: 'asc' }).dir, 1);
  assert.equal(q.parseParams({ dir: 'asc' }).dir, 1);
  assert.equal(q.parseParams({ dir: 'asc' }).sort, 'orderDate');
});

test('parseParams: trang / cỡ trang — số nguyên dương, cỡ trang tối đa 200, giá trị lạ về mặc định', () => {
  assert.equal(q.parseParams({ page: '3' }).page, 3);
  assert.equal(q.parseParams({ page: '0' }).page, 1);
  assert.equal(q.parseParams({ page: 'abc' }).page, 1);
  assert.equal(q.parseParams({ pageSize: '50' }).pageSize, 50);
  assert.equal(q.parseParams({ pageSize: '100000' }).pageSize, 200);
  assert.equal(q.parseParams({ pageSize: '-5' }).pageSize, 100);
});

test('parseParams: giá trị liệt kê sai -> lỗi 400 kèm mã; chuỗi tìm kiếm tự do không báo lỗi', () => {
  const fails = (input, code) => assert.throws(() => q.parseParams(input), err => err.statusCode === 400 && err.code === code);
  fails({ branch: 'HCM' }, 'INVALID_BRANCH');
  fails({ sort: 'password' }, 'INVALID_SORT');
  fails({ dir: 'sideways' }, 'INVALID_SORT');
  fails({ dateField: 'orderTotal' }, 'INVALID_DATE_FIELD');
  fails({ mode: 'sql' }, 'INVALID_SEARCH_MODE');
  fails({ from: '30/09/2026' }, 'INVALID_DATE');
  fails({ to: '2026-13-45' }, 'INVALID_DATE');
  assert.doesNotThrow(() => q.parseParams({ q: "'; DROP TABLE orders; --", kiotStatus: 'không có trạng thái này', status: 'ZZZ' }));
  // Gia tri khong phai chuoi (vd query lap tham so -> mang) bi bo qua, khong lam hong.
  assert.equal(q.parseParams({ q: ['a', 'b'], branch: ['HN'] }).q, '');
});

// ---------------------------------------------------------------------------
// Loc
// ---------------------------------------------------------------------------

const SAMPLE = () => [
  row('DH001', { branch: 'HN', saleName: 'Nguyễn Văn An', customerName: 'Cửa hàng Hoa', kiotStatus: 'Phiếu tạm', orderDate: '05/10/2026 09:00' }),
  row('DH002', { branch: 'SG', saleName: 'Trần Thị Bình', customerName: 'Siêu thị An Phát', kiotStatus: 'Hoàn thành', sellableValue: null, orderDate: '04/10/2026 23:30' }),
  row('dh003', { branch: 'HN', saleName: 'Lê Đức', customerName: 'Khách lẻ', kiotStatus: 'Đã hủy', sellableValue: null, orderDate: '30/09/2026 08:00',
    summary: { code: 'DELIVERING', label: 'Đơn đang được giao', at: '01/10/2026 12:00' }, saleSentAt: '30/09/2026 10:47' }),
  row('DH004', { branch: 'SG', kiotStatus: '', source: 'sheet', sellableValue: null, orderTotal: null, orderDate: '' })
];

test('lọc theo cơ sở / trạng thái vòng đời / trạng thái Kiot', () => {
  const rows = SAMPLE();
  const select = params => codes(q.selectRows(rows, q.parseParams({ sort: 'orderCode', ...params })));
  assert.deepEqual(select({ branch: 'SG' }), ['DH002', 'DH004']);
  assert.deepEqual(select({ status: 'DELIVERING' }), ['dh003']);
  assert.deepEqual(select({ kiotStatus: 'Hoàn thành' }), ['DH002']);
  assert.deepEqual(select({ kiotStatus: 'Phiếu tạm', branch: 'SG' }), []);
  assert.deepEqual(select({}), ['DH001', 'DH002', 'dh003', 'DH004']);
});

test('tìm theo mã: nhiều mã cách nhau khoảng trắng, không phân biệt hoa/thường/dấu, khớp một phần; trùng mã được loại', () => {
  const rows = SAMPLE();
  const select = text => codes(q.selectRows(rows, q.parseParams({ q: text, sort: 'orderCode' })));
  assert.deepEqual(select('dh003'), ['dh003']);
  assert.deepEqual(select('DH001   dh004'), ['DH001', 'DH004']);
  assert.deepEqual(select('dh00'), ['DH001', 'DH002', 'dh003', 'DH004']);
  assert.deepEqual(select('dh001 DH001'), ['DH001']);
  assert.deepEqual(select('khong-co'), []);
});

test('tìm theo tên sale / khách hàng: không dấu, một phần', () => {
  const rows = SAMPLE();
  const bySale = text => codes(q.selectRows(rows, q.parseParams({ mode: 'sale', q: text, sort: 'orderCode' })));
  assert.deepEqual(bySale('tran thi binh'), ['DH002']);
  assert.deepEqual(bySale('LE DUC'), ['dh003']);
});

test('tìm theo tên khách khớp theo chuỗi không dấu liền nhau (không phải từng từ)', () => {
  const rows = SAMPLE();
  const byCustomer = text => codes(q.selectRows(rows, q.parseParams({ mode: 'customer', q: text, sort: 'orderCode' })));
  // "Cửa hàng Hoa" -> "cua hang hoa"; "Siêu thị An Phát" -> "sieu thi an phat"; "Khách lẻ" -> "khach le"
  assert.deepEqual(byCustomer('hoa'), ['DH001']);
  assert.deepEqual(byCustomer('an phat'), ['DH002']);
  assert.deepEqual(byCustomer('khach le'), ['dh003']);
});

test('lọc khoảng thời gian: gồm cả ngày cuối (23:59:59), dòng chưa có mốc thời gian đó bị loại khi đã chọn khoảng; chỉ có "từ" hoặc chỉ có "đến" đều được', () => {
  const rows = SAMPLE();
  const select = params => codes(q.selectRows(rows, q.parseParams({ sort: 'orderCode', ...params })));
  assert.deepEqual(select({ dateField: 'orderDate', from: '2026-10-04', to: '2026-10-04' }), ['DH002'], '04/10 23:30 van nam trong ngay cuoi');
  assert.deepEqual(select({ dateField: 'orderDate', from: '2026-10-04' }), ['DH001', 'DH002']);
  assert.deepEqual(select({ dateField: 'orderDate', to: '2026-09-30' }), ['dh003']);
  assert.deepEqual(select({ dateField: 'saleSentAt', from: '2026-09-30', to: '2026-09-30' }), ['dh003']);
  assert.deepEqual(select({ dateField: 'at', from: '2026-10-01', to: '2026-10-01' }), ['dh003']);
  assert.deepEqual(select({ dateField: 'orderDate' }), ['DH001', 'DH002', 'dh003', 'DH004'], 'chua chon khoang -> khong loc');
});

test('rowsInBranch + filterRows không sửa mảng nguồn; không có bộ lọc trả lại đúng mảng (không sao chép 60 nghìn dòng)', () => {
  const rows = SAMPLE();
  const copy = rows.slice();
  assert.equal(q.rowsInBranch(rows, ''), rows);
  assert.equal(q.filterRows(rows, q.parseParams({})), rows);
  q.selectRows(rows, q.parseParams({ branch: 'HN', kiotStatus: 'Đã hủy' }));
  assert.deepEqual(rows, copy);
});

// ---------------------------------------------------------------------------
// Sap xep
// ---------------------------------------------------------------------------

test('sắp xếp mặc định: thời gian đặt hàng THẬT mới nhất trước (không theo chuỗi dd/MM/yyyy); dòng không có ngày luôn cuối', () => {
  const rows = [
    row('A', { orderDate: '30/09/2026 23:30' }),
    row('B', { orderDate: '' }),
    row('C', { orderDate: '05/01/2027 09:00' }),
    row('D', { orderDate: '01/10/2026 07:00' })
  ];
  assert.deepEqual(codes(q.selectRows(rows, q.parseParams({}))), ['C', 'D', 'A', 'B']);
  assert.deepEqual(codes(q.selectRows(rows, q.parseParams({ sort: 'orderDate', dir: 'asc' }))), ['A', 'D', 'C', 'B'], 'tang dan: dong rong VAN o cuoi');
});

test('sắp xếp số (Giá trị đơn / Giá trị có bán): theo SỐ không theo chuỗi; đơn không có Kiot hoặc không phải Phiếu tạm luôn cuối', () => {
  const rows = [
    row('A', { orderTotal: 9000000, sellableValue: 9000000 }),
    row('B', { orderTotal: 10000000, sellableValue: 10000000 }),
    row('C', { kiotStatus: '', source: 'sheet', orderTotal: null, sellableValue: null }),
    row('D', { orderTotal: 250000, sellableValue: null, kiotStatus: 'Hoàn thành' }),
    row('E', { orderTotal: 5, sellableValue: 5, kiotStatus: '' }) // khong co don Kiot: gia tri bi bo qua du truong co so
  ];
  assert.deepEqual(codes(q.selectRows(rows, q.parseParams({ sort: 'orderTotal', dir: 'asc' }))), ['D', 'A', 'B', 'C', 'E']);
  assert.deepEqual(codes(q.selectRows(rows, q.parseParams({ sort: 'orderTotal', dir: 'desc' }))), ['B', 'A', 'D', 'C', 'E']);
  assert.deepEqual(codes(q.selectRows(rows, q.parseParams({ sort: 'sellableValue', dir: 'asc' }))), ['A', 'B', 'C', 'D', 'E']);
});

test('sắp xếp chữ: không dấu, không phân biệt hoa/thường; Ghi chú / Trạng thái KiotViet trống luôn cuối', () => {
  const rows = [
    row('A', { saleName: 'Đặng Văn', note: 'beta', kiotStatus: 'Hoàn thành' }),
    row('B', { saleName: 'An', note: '', kiotStatus: '' }),
    row('C', { saleName: 'Bình', note: 'Alpha', kiotStatus: 'Đã hủy' })
  ];
  assert.deepEqual(codes(q.selectRows(rows, q.parseParams({ sort: 'saleName', dir: 'asc' }))), ['B', 'C', 'A'], 'An < Binh < Dang');
  assert.deepEqual(codes(q.selectRows(rows, q.parseParams({ sort: 'note', dir: 'asc' }))), ['C', 'A', 'B']);
  assert.deepEqual(codes(q.selectRows(rows, q.parseParams({ sort: 'note', dir: 'desc' }))), ['A', 'C', 'B'], 'ghi chu trong VAN o cuoi khi giam dan');
  assert.deepEqual(codes(q.selectRows(rows, q.parseParams({ sort: 'kiotStatus', dir: 'asc' }))), ['C', 'A', 'B']);
});

test('sắp xếp theo trạng thái vòng đời (nhãn), thời gian "Sale ra đơn" / "Cập nhật gần nhất", cảnh báo', () => {
  const rows = [
    row('A', { saleSentAt: '05/01/2027 08:00', summary: { code: 'DELIVERING', label: 'Đơn đang được giao', at: '05/01/2027 09:00' }, warning: false }),
    row('B', { saleSentAt: '30/09/2026 10:47', summary: { code: 'DELIVERING', label: 'Đơn đang được giao', at: '02/10/2026 10:00' }, warning: true }),
    row('C', { saleSentAt: '01/10/2026 07:00', summary: { code: 'SENT_TO_ACCOUNTANT', label: 'Đơn đã gửi kế toán', at: '01/10/2026 12:00' } }),
    row('D', { saleSentAt: '' })
  ];
  assert.deepEqual(codes(q.selectRows(rows, q.parseParams({ sort: 'saleSentAt', dir: 'asc' }))), ['B', 'C', 'A', 'D']);
  assert.deepEqual(codes(q.selectRows(rows, q.parseParams({ sort: 'saleSentAt', dir: 'desc' }))), ['A', 'C', 'B', 'D']);
  assert.deepEqual(codes(q.selectRows(rows, q.parseParams({ sort: 'at', dir: 'asc' }))), ['C', 'B', 'A', 'D']);
  assert.equal(codes(q.selectRows(rows, q.parseParams({ sort: 'warning', dir: 'desc' })))[0], 'B');
  // Nhan trang thai khong dau: "don chua gui ke toan" < "don da gui ke toan" < "don dang duoc giao" (A, B giu thu tu goc).
  assert.deepEqual(codes(q.selectRows(rows, q.parseParams({ sort: 'status', dir: 'asc' }))), ['D', 'C', 'A', 'B']);
});

test('sắp xếp bền vững: giá trị bằng nhau giữ thứ tự gốc (cả tăng lẫn giảm dần)', () => {
  const rows = ['A', 'B', 'C', 'D'].map(code => row(code, { orderDate: '01/10/2026 10:00', saleName: 'Cùng tên' }));
  assert.deepEqual(codes(q.selectRows(rows, q.parseParams({ sort: 'saleName', dir: 'asc' }))), ['A', 'B', 'C', 'D']);
  assert.deepEqual(codes(q.selectRows(rows, q.parseParams({ sort: 'saleName', dir: 'desc' }))), ['A', 'B', 'C', 'D']);
  assert.deepEqual(codes(q.selectRows(rows, q.parseParams({}))), ['A', 'B', 'C', 'D']);
});

// ---------------------------------------------------------------------------
// Phan trang, danh sach trang thai Kiot, bo nho dem
// ---------------------------------------------------------------------------

test('paginate: cắt đúng trang, kẹp trang vượt/âm, ít nhất 1 trang kể cả danh sách rỗng', () => {
  const rows = Array.from({ length: 250 }, (_, i) => i);
  assert.deepEqual(q.paginate(rows, 1, 100).items.length, 100);
  assert.deepEqual(q.paginate(rows, 3, 100).items, rows.slice(200));
  const beyond = q.paginate(rows, 99, 100);
  assert.deepEqual([beyond.page, beyond.totalPages, beyond.items.length], [3, 3, 50]);
  assert.equal(q.paginate(rows, -4, 100).page, 1);
  const empty = q.paginate([], 1, 100);
  assert.deepEqual([empty.items.length, empty.page, empty.totalPages], [0, 1, 1]);
});

test('distinctKiotStatuses: theo thứ tự quen thuộc (Phiếu tạm, Đã xác nhận, Đang giao hàng, Hoàn thành, Đã hủy) rồi trạng thái lạ theo tên; bỏ rỗng', () => {
  const rows = ['Đã hủy', 'Hoàn thành', 'Zeta mới', '', 'Phiếu tạm', 'Alpha mới', 'Hoàn thành', 'Đang giao hàng'].map((status, i) => row('R' + i, { kiotStatus: status }));
  assert.deepEqual(q.distinctKiotStatuses(rows), ['Phiếu tạm', 'Đang giao hàng', 'Hoàn thành', 'Đã hủy', 'Alpha mới', 'Zeta mới']);
});

test('createSelectionCache: dùng lại kết quả cùng bộ lọc trên cùng mảng nguồn (lật trang không sắp xếp lại); mảng nguồn mới thì bỏ hết; giới hạn số mục', () => {
  const rows = SAMPLE();
  const cache = q.createSelectionCache(2);
  const a1 = cache.select(rows, q.parseParams({ sort: 'orderCode' }));
  const a2 = cache.select(rows, q.parseParams({ sort: 'orderCode', page: '5', pageSize: '10' }));
  assert.equal(a2, a1, 'trang / co trang khong nam trong khoa');
  const b = cache.select(rows, q.parseParams({ sort: 'saleName' }));
  assert.notEqual(b, a1);
  cache.select(rows, q.parseParams({ kiotStatus: 'Đã hủy' })); // them muc thu 3: day muc cu nhat (orderCode) ra
  assert.notEqual(cache.select(rows, q.parseParams({ sort: 'orderCode' })), a1, 'muc cu nhat da bi day ra, dung lai moi');

  const other = rows.slice();
  assert.notEqual(cache.select(other, q.parseParams({ sort: 'saleName' })), b, 'mang nguon doi -> bo nho dem bi bo het');
});

test('hiệu năng thô: 60.000 dòng — lọc + sắp xếp chữ và số trong ngưỡng rộng (bắt hồi quy O(n²))', () => {
  const rows = Array.from({ length: 60000 }, (_, i) => row('DH' + String(i).padStart(6, '0'), {
    branch: i % 3 ? 'HN' : 'SG', saleName: 'Nguyễn Văn ' + (i % 97), customerName: 'Khách hàng số ' + i,
    kiotStatus: i % 50 === 0 ? 'Phiếu tạm' : (i % 4 ? 'Hoàn thành' : 'Đã hủy'), orderTotal: i * 7, note: i % 2 ? 'ghi chú ' + i : '',
    orderDate: `${String(1 + (i % 28)).padStart(2, '0')}/10/2026 ${String(i % 24).padStart(2, '0')}:00`
  }));
  const start = Date.now();
  q.selectRows(rows, q.parseParams({ kiotStatus: 'Hoàn thành', mode: 'sale', q: 'nguyen van 5', sort: 'customerName', dir: 'asc' }));
  q.selectRows(rows, q.parseParams({ sort: 'note', dir: 'desc' }));
  q.selectRows(rows, q.parseParams({ sort: 'orderTotal' }));
  assert.ok(Date.now() - start < 8000, 'qua cham: ' + (Date.now() - start) + 'ms');
});

// ---------------------------------------------------------------------------
// countSummary — chi so tong quat dau trang
// ---------------------------------------------------------------------------

function summaryRow(code, summaryCode, extra = {}) {
  return row(code, { summary: { code: summaryCode, label: summaryCode, at: null }, ...extra });
}

test('countSummary: 3 trạng thái — "Chưa gửi KT" chỉ tính đơn Phiếu tạm; các mã cảnh báo đếm đủ, 0 nếu vắng; đơn nhiều cảnh báo đếm 1 lần ở "any"', () => {
  const rows = [
    summaryRow('A', 'NOT_SENT'),
    summaryRow('B', 'NOT_SENT', { kiotStatus: 'Hoàn thành' }),
    summaryRow('C', 'NOT_SENT', { kiotStatus: 'Đã hủy' }),
    summaryRow('D', 'SENT_TO_ACCOUNTANT', { kiotStatus: 'Đã xác nhận', warnings: ['ACCOUNTANT_LATE'], warning: true }),
    summaryRow('E', 'DELIVERING', { kiotStatus: 'Đang giao hàng', warnings: ['NOT_SIGNED_6H', 'DRIVER_NO_PHOTO'], warning: true }),
    summaryRow('F', 'SIGNED', { kiotStatus: 'Hoàn thành' })
  ];
  assert.deepEqual(q.countSummary(rows, q.parseParams({})), {
    status: { NOT_SENT: 1, SENT_TO_ACCOUNTANT: 1, DELIVERING: 1 },
    warnings: {
      any: 2, ACCOUNTANT_LATE: 1, DRIVER_NO_PHOTO: 1, DRIVER_FORGOT_PHOTO: 0, NOT_SIGNED_6H: 1, PICKUP_PENDING: 0, NO_TRAIN_BILL: 0,
      PICK_KIOT_DIFF: 0, PICK_ORDER_DIFF: 0
    }
  });
});

test('countSummary: tôn trọng bộ lọc cơ sở / ngày / tìm kiếm / trạng thái Kiot, nhưng thẻ trạng thái bỏ lọc status và thẻ cảnh báo bỏ lọc warning', () => {
  const rows = [
    summaryRow('HN1', 'NOT_SENT', { orderDate: '01/10/2026 10:00' }),
    summaryRow('HN2', 'DELIVERING', { kiotStatus: 'Đang giao hàng', orderDate: '01/10/2026 11:00', warnings: ['NOT_SIGNED_6H'], warning: true }),
    summaryRow('HN3', 'DELIVERING', { kiotStatus: 'Đang giao hàng', orderDate: '05/10/2026 11:00', warnings: ['NOT_SIGNED_6H'], warning: true }),
    summaryRow('SG1', 'NOT_SENT', { branch: 'SG', orderDate: '01/10/2026 10:00' })
  ];
  // Dang loc "Dang giao": the "Chua gui" van dem don Phieu tam khac, khong ve 0.
  const delivering = q.countSummary(rows, q.parseParams({ status: 'DELIVERING' }));
  assert.deepEqual(delivering.status, { NOT_SENT: 2, SENT_TO_ACCOUNTANT: 0, DELIVERING: 2 });
  // Dang loc 1 ma canh bao: cac the canh bao van thay cac ma khac / tong.
  assert.equal(q.countSummary(rows, q.parseParams({ warning: 'PICKUP_PENDING' })).warnings.NOT_SIGNED_6H, 2);
  // Co so + khoang ngay thu hep tap dem.
  const narrowed = q.countSummary(rows, q.parseParams({ branch: 'HN', dateField: 'orderDate', from: '2026-10-01', to: '2026-10-01' }));
  assert.deepEqual(narrowed.status, { NOT_SENT: 1, SENT_TO_ACCOUNTANT: 0, DELIVERING: 1 });
  assert.equal(narrowed.warnings.any, 1);
  // Loc Trang thai Kiot "Hoan thanh": khong con don Phieu tam nao -> 0.
  assert.equal(q.countSummary(rows, q.parseParams({ kiotStatus: 'Hoàn thành' })).status.NOT_SENT, 0);
});

test('countFacets: mỗi ô lọc đếm theo CÁC bộ lọc khác (bỏ chính nó) nên giá trị không còn đơn nào được lộ ra để khóa', () => {
  const rows = [
    summaryRow('HN1', 'NOT_SENT', { kiotStatus: 'Phiếu tạm', warnings: ['ACCOUNTANT_LATE'] }),
    summaryRow('HN2', 'DELIVERING', { kiotStatus: 'Đang giao hàng', warnings: ['NOT_SIGNED_6H', 'NO_TRAIN_BILL'] }),
    summaryRow('SG1', 'NOT_SENT', { branch: 'SG', kiotStatus: 'Phiếu tạm' }),
    summaryRow('SG2', 'COMPLETED', { branch: 'SG', kiotStatus: 'Hoàn thành' })
  ];
  const pickOf = row => ({ HN1: 'picking', SG2: 'confirmed' }[row.orderCode] || 'none');
  // Không lọc gì: đếm toàn bộ.
  const all = q.countFacets(rows, q.parseParams({}), pickOf);
  assert.deepEqual(all.branch, { HN: 2, SG: 2 });
  assert.deepEqual(all.status, { NOT_SENT: 2, DELIVERING: 1, COMPLETED: 1 });
  assert.deepEqual(all.warning, { any: 2, ACCOUNTANT_LATE: 1, NOT_SIGNED_6H: 1, NO_TRAIN_BILL: 1 });
  assert.deepEqual(all.pick, { picking: 1, none: 2, confirmed: 1 });
  // Đang lọc Sài Gòn: Trạng thái/Kiot/Cảnh báo/Bốc chỉ còn giá trị của đơn SG; ô Cơ sở vẫn thấy cả HN (bỏ chính nó).
  const sg = q.countFacets(rows, q.parseParams({ branch: 'SG' }), pickOf);
  assert.deepEqual(sg.branch, { HN: 2, SG: 2 });
  assert.deepEqual(sg.status, { NOT_SENT: 1, COMPLETED: 1 });
  assert.deepEqual(sg.kiot, { 'Phiếu tạm': 1, 'Hoàn thành': 1 });
  assert.deepEqual(sg.warning, {});
  assert.deepEqual(sg.pick, { none: 1, confirmed: 1 });
  // Hai bộ lọc cùng lúc (Sài Gòn + Hoàn thành): ô Kiot vẫn đếm theo Sài Gòn, ô Trạng thái theo Sài Gòn + Kiot...
  const two = q.countFacets(rows, q.parseParams({ branch: 'SG', status: 'COMPLETED' }), pickOf);
  assert.deepEqual(two.kiot, { 'Hoàn thành': 1 });
  assert.deepEqual(two.status, { NOT_SENT: 1, COMPLETED: 1 });
  assert.deepEqual(two.branch, { SG: 1 });
  // Không truyền pickOf (người không có quyền bốc): không có facet pick.
  assert.equal(q.countFacets(rows, q.parseParams({})).pick, undefined);
  // Tìm kiếm / khoảng ngày vẫn áp cho mọi ô.
  const searched = q.countFacets(rows, q.parseParams({ mode: 'code', q: 'hn2' }), pickOf);
  assert.deepEqual(searched.branch, { HN: 1 });
});

test('countSummary tính trên toàn bộ kết quả tìm gần đúng (không chỉ trang hiện tại)', () => {
  const rows = [
    row('A', { saleName: 'Nguyễn Văn An', kiotStatus: 'Phiếu tạm', summary: { code: 'NOT_SENT', label: 'x', at: '' } }),
    row('B', { saleName: 'Nguyễn Thị Bình', kiotStatus: 'Phiếu tạm', summary: { code: 'NOT_SENT', label: 'x', at: '' } }),
    row('C', { saleName: 'Trần Văn Cường', kiotStatus: 'Phiếu tạm', summary: { code: 'NOT_SENT', label: 'x', at: '' } })
  ];
  assert.equal(q.countSummary(rows, q.parseParams({ mode: 'sale', q: 'nguyen' })).status.NOT_SENT, 2);
  assert.equal(q.countSummary(rows, q.parseParams({})).status.NOT_SENT, 3);
});
