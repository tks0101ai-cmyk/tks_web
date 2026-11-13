# Sửa lỗi tạo mã QR VietQR — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Danh sách tài khoản nhận tiền luôn hiện ngay; mã QR chỉ được tạo/hiện khi đủ thông tin hợp lệ theo chuẩn VietQR.

**Architecture:** Máy chủ tách `GET /api/vat-draft/meta` (chỉ danh sách tài khoản + ngân hàng, trả ngay) khỏi `GET /api/vat-draft/master-data/status` (trạng thái Google Sheets + KiotViet). Thêm module danh sách ngân hàng VietQR tĩnh và các hàm chuẩn hóa/kiểm tra trong `vietqr.js`; `service.qrUrl` từ chối dữ liệu sai (400). Trang `vat-draft.js` tải tài khoản có thử lại, chép cùng quy tắc kiểm tra để khóa nút, hiện dòng "Nội dung trong QR", xử lý ảnh QR lỗi tải; thẻ QR tab Xử lý bắt chọn tài khoản khi nguồn không có cấu hình.

**Tech Stack:** Node.js 22/24 CommonJS, Express, `node:test`, JSDOM (test trang), Vanilla JS/HTML/CSS.

Spec: `docs/superpowers/specs/2026-11-13-vietqr-generation-fixes-design.md`

## Global Constraints

- Nội dung chuyển khoản trong QR: tối đa **50** ký tự sau chuẩn hóa; quá thì **chặn**, không tự cắt.
- Chuẩn hóa nội dung: bỏ dấu (NFD + bỏ `̀-ͯ`), `đ/Đ` → `d/D`, mọi ký tự không phải `A-Za-z0-9` → dấu cách, gộp dấu cách, bỏ đầu/cuối.
- Số tài khoản: `/^[A-Za-z0-9]{1,19}$/`. Số tiền: rỗng/0 được phép, có số thì tối đa **13** chữ số.
- Mã ngân hàng nhập tay phải khớp `code`, `shortName` hoặc `bin` trong danh sách VietQR (không phân biệt hoa/thường); máy chủ dựng URL bằng `bin`.
- Nguồn không có trong `sourceAccountMap` và chế độ gộp không VAT: `defaultAccountKey = null` (bắt chọn tay).
- Không TailwindCSS / framework; CSS dùng biến trong `shared.css` (`--muted`, `--amber`, `--red`).
- Chạy test: từ thư mục `server/`, `node --test <file>` (Node 24 cần đường dẫn file cụ thể hoặc glob).
- Chuỗi hiển thị cho người dùng bằng tiếng Việt có dấu; chú thích trong code giữ kiểu hiện có (không dấu).

**Lệch nhỏ so với spec (có chủ đích):**
- Spec ghi tách `state.meta` thành `state.accounts`/`state.status`. Kế hoạch giữ `state.meta` và ghép hai nguồn vào (`{ vietqr }` + `{ masterData, sync }`) — `renderMeta()` đã kiểm tra `meta.masterData`, ít sửa hơn, cùng hành vi.
- Danh sách ngân hàng chỉ gồm ngân hàng có `transferSupported = 1` trong `api.vietqr.io/v2/banks` (48 ngân hàng): ngân hàng không hỗ trợ chuyển khoản Napas thì QR cũng không chuyển được.

> Cập nhật 13/11/2026: danh sách ngân hàng đã đổi thành đủ 76 ngân hàng và URL ảnh dùng `.svg` — xem spec mục 3.2 và 3.5 (Task 7, ngoài kế hoạch ban đầu).

## File Structure

| File | Trách nhiệm |
|---|---|
| `server/vatDraft/vietqrBanks.js` (mới) | Danh sách ngân hàng VietQR tĩnh + `findBank(input)` |
| `server/vatDraft/vietqrBanks.test.js` (mới) | Test `findBank` |
| `server/vatDraft/vietqr.js` | Thêm `normalizeTransferContent`, `isValidAccountNo`, hằng số giới hạn; bỏ `isValidManualField` |
| `server/vatDraft/vietqr.test.js` | Test các hàm mới |
| `server/vatDraft/vatDraftService.js` | `qrUrl` kiểm tra + chuẩn hóa; `accountsMeta` trả `banks`; `allocate` bỏ mặc định VCB TKS |
| `server/vatDraft/vatDraftRoutes.js` | `/meta` trả ngay; thêm `/master-data/status` |
| `server/vatDraft/vatDraftRoutes.test.js` | Test route |
| `server/public/vat-draft/index.html` | Nút Thử lại, datalist ngân hàng, dòng xem trước nội dung |
| `server/public/vat-draft/vat-draft.css` | Kiểu dòng xem trước nội dung |
| `server/public/vat-draft/vat-draft.js` | Tải tài khoản/trạng thái tách riêng, kiểm tra, khóa nút, ảnh lỗi |
| `server/test/frontend/vat-draft.test.js` | Test trang |
| `README.md`, `server/README.md`, `docs/02-srs/SRS_Dashboard_GoogleSheets.md`, `docs/04-planning/implementation_plan.md`, `CURRENT.md` | Tài liệu |

---

### Task 1: Danh sách ngân hàng VietQR + hàm chuẩn hóa/kiểm tra

**Files:**
- Create: `server/vatDraft/vietqrBanks.js`
- Create: `server/vatDraft/vietqrBanks.test.js`
- Modify: `server/vatDraft/vietqr.js`
- Modify: `server/vatDraft/vietqr.test.js`

**Interfaces:**
- Produces:
  - `require('./vietqrBanks')` → `{ VIETQR_BANKS: Array<{ bin: string, code: string, shortName: string }>, findBank(input: string): { bin, code, shortName } | null }`
  - `require('./vietqr')` thêm `{ MAX_TRANSFER_CONTENT: 50, MAX_AMOUNT_DIGITS: 13, normalizeTransferContent(text: any): string, isValidAccountNo(value: any): boolean }`; **bỏ** `isValidManualField`.

- [ ] **Step 1: Viết test hỏng cho `findBank`**

Tạo `server/vatDraft/vietqrBanks.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VIETQR_BANKS, findBank } = require('./vietqrBanks');
const vatDraftConfig = require('./vatDraftConfig');

test('findBank: khop code / shortName / bin, khong phan biet hoa thuong, bo khoang trang', () => {
  assert.equal(findBank('VCB').bin, '970436');
  assert.equal(findBank(' vietcombank ').bin, '970436');
  assert.equal(findBank('970422').code, 'MB');
  assert.equal(findBank('mbbank').code, 'MB');
  assert.equal(findBank('Vietinbank').code, 'ICB');
  assert.equal(findBank('VCB/x'), null);
  assert.equal(findBank('KHONGCO'), null);
  assert.equal(findBank(''), null);
  assert.equal(findBank(undefined), null);
});

test('moi tai khoan cau hinh dung ma ngan hang co trong danh sach VietQR', () => {
  for (const account of vatDraftConfig.vietqr.accounts) {
    assert.ok(findBank(account.bankId), `${account.key}: ${account.bankId}`);
  }
  assert.equal(new Set(VIETQR_BANKS.map(b => b.bin)).size, VIETQR_BANKS.length, 'bin khong trung');
});
```

- [ ] **Step 2: Chạy test, xác nhận hỏng**

Run: `cd server && node --test vatDraft/vietqrBanks.test.js`
Expected: FAIL — `Cannot find module './vietqrBanks'`

- [ ] **Step 3: Tạo `server/vatDraft/vietqrBanks.js`**

```js
'use strict';

// Danh sach ngan hang VietQR (chi ngan hang ho tro chuyen khoan Napas, transferSupported = 1),
// chep tu https://api.vietqr.io/v2/banks ngay 13/11/2026. Khong goi API luc chay.
// Them / bot ngan hang = sua file nay qua PR.

const BANK_ROWS = [
  ['970415', 'ICB', 'VietinBank'],
  ['970436', 'VCB', 'Vietcombank'],
  ['970418', 'BIDV', 'BIDV'],
  ['970405', 'VBA', 'Agribank'],
  ['970448', 'OCB', 'OCB'],
  ['970422', 'MB', 'MBBank'],
  ['970407', 'TCB', 'Techcombank'],
  ['970416', 'ACB', 'ACB'],
  ['970432', 'VPB', 'VPBank'],
  ['970423', 'TPB', 'TPBank'],
  ['970403', 'STB', 'Sacombank'],
  ['970437', 'HDB', 'HDBank'],
  ['970454', 'VCCB', 'VietCapitalBank'],
  ['970429', 'SCB', 'SCB'],
  ['970441', 'VIB', 'VIB'],
  ['970443', 'SHB', 'SHB'],
  ['970431', 'EIB', 'Eximbank'],
  ['970426', 'MSB', 'MSB'],
  ['546034', 'CAKE', 'CAKE'],
  ['546035', 'Ubank', 'Ubank'],
  ['963388', 'TIMO', 'Timo'],
  ['970400', 'SGICB', 'SaigonBank'],
  ['970409', 'BAB', 'BacABank'],
  ['971133', 'PVDB', 'PVcomBank Pay'],
  ['971025', 'momo', 'MoMo'],
  ['970412', 'PVCB', 'PVcomBank'],
  ['970414', 'MBV', 'MBV'],
  ['970419', 'NCB', 'NCB'],
  ['970424', 'SHBVN', 'ShinhanBank'],
  ['970425', 'ABB', 'ABBANK'],
  ['970427', 'VAB', 'VietABank'],
  ['970428', 'NAB', 'NamABank'],
  ['970430', 'PGB', 'PGBank'],
  ['970433', 'VIETBANK', 'VietBank'],
  ['970438', 'BVB', 'BaoVietBank'],
  ['970440', 'SEAB', 'SeABank'],
  ['970446', 'COOPBANK', 'COOPBANK'],
  ['970449', 'LPB', 'LPBank'],
  ['970452', 'KLB', 'KienLongBank'],
  ['668888', 'KBank', 'KBank'],
  ['971101', 'ZALOPAY', 'ZaloPay'],
  ['971032', 'MVAS', 'MVAS'],
  ['970434', 'IVB', 'IndovinaBank'],
  ['422589', 'CIMB', 'CIMB'],
  ['970444', 'CBB', 'CBBank'],
  ['970457', 'WVN', 'Woori'],
  ['970462', 'KBHN', 'KookminHN'],
  ['970463', 'KBHCM', 'KookminHCM']
];

const VIETQR_BANKS = Object.freeze(BANK_ROWS.map(([bin, code, shortName]) => Object.freeze({ bin, code, shortName })));

/** Ngan hang khop ma viet tat (code), ten ngan (shortName) hoac BIN; khong phan biet hoa/thuong. */
function findBank(input) {
  const target = String(input ?? '').trim().toLowerCase();
  if (!target) return null;
  return VIETQR_BANKS.find(bank => [bank.bin, bank.code, bank.shortName].some(value => value.toLowerCase() === target)) || null;
}

module.exports = { VIETQR_BANKS, findBank };
```

- [ ] **Step 4: Chạy test, xác nhận qua**

Run: `cd server && node --test vatDraft/vietqrBanks.test.js`
Expected: PASS (2 test)

- [ ] **Step 5: Viết test hỏng cho hàm mới trong `vietqr.js`**

Trong `server/vatDraft/vietqr.test.js`, đổi khối import: bỏ `isValidManualField`, thêm `normalizeTransferContent`, `isValidAccountNo`, `MAX_TRANSFER_CONTENT`, `MAX_AMOUNT_DIGITS`:

```js
const {
  getAccountForSource,
  getAccountsForSeller,
  computeSourceAmounts,
  computeTotalAmount,
  formatAccountLabel,
  parseAmountInput,
  buildVietqrImageUrl,
  normalizeTransferContent,
  isValidAccountNo,
  MAX_TRANSFER_CONTENT,
  MAX_AMOUNT_DIGITS
} = require('./vietqr');
```

Thay test cuối `'nhan tai khoan va kiem tra o nhap tay'` bằng:

```js
test('nhan tai khoan va kiem tra so tai khoan nhap tay (toi da 19 chu/so)', () => {
  assert.equal(formatAccountLabel(vatDraftConfig.vietqr.accounts[1]), 'MB TKS — MB 606266688888 (CONG TY CO PHAN THUONG MAI XUAT NHAP KHAU TKS GROUP)');
  assert.equal(formatAccountLabel({ bankId: 'VCB', accountNo: '123', accountName: '' }), 'VCB - 123');
  assert.ok(isValidAccountNo('1'));
  assert.ok(isValidAccountNo('0034100123456688'));
  assert.ok(isValidAccountNo('A'.repeat(19)));
  assert.ok(!isValidAccountNo('1'.repeat(20)));
  assert.ok(!isValidAccountNo('123/../x'));
  assert.ok(!isValidAccountNo('123 456'));
  assert.ok(!isValidAccountNo(''));
  assert.equal(MAX_AMOUNT_DIGITS, 13);
});

test('chuan hoa noi dung chuyen khoan theo VietQR: bo dau, bo ky tu dac biet, khong cat', () => {
  assert.equal(MAX_TRANSFER_CONTENT, 50);
  assert.equal(normalizeTransferContent('Hóa đơn HD028345, chị Lan'), 'Hoa don HD028345 chi Lan');
  assert.equal(normalizeTransferContent('ĐẶNG THỊ ÁNH NGUYỆT'), 'DANG THI ANH NGUYET');
  assert.equal(normalizeTransferContent('  HD1   HD2\tDH3  '), 'HD1 HD2 DH3');
  assert.equal(normalizeTransferContent('TT #12/11 (gấp)!'), 'TT 12 11 gap');
  assert.equal(normalizeTransferContent(''), '');
  assert.equal(normalizeTransferContent(null), '');
  assert.equal(normalizeTransferContent(undefined), '');
  const long = Array.from({ length: 8 }, (_, i) => `HD02834${i}`).join(' ');
  assert.equal(normalizeTransferContent(long), long, 'khong tu cat — kiem tra do dai o noi goi');
  assert.ok(normalizeTransferContent(long).length > MAX_TRANSFER_CONTENT);
});
```

- [ ] **Step 6: Chạy test, xác nhận hỏng**

Run: `cd server && node --test vatDraft/vietqr.test.js`
Expected: FAIL — `normalizeTransferContent is not a function` (hoặc `isValidAccountNo is not a function`)

- [ ] **Step 7: Sửa `server/vatDraft/vietqr.js`**

Thay dòng `const MANUAL_FIELD_RE = /^[A-Za-z0-9]{2,25}$/;` bằng:

```js
// Gioi han cua VietQR Quick Link: addInfo toi da 50 ky tu khong ky tu dac biet, so TK toi da 19
// chu/so, so tien toi da 13 chu so. Vuot gioi han thi anh van ra nhung app ngan hang tu choi.
const MAX_TRANSFER_CONTENT = 50;
const MAX_AMOUNT_DIGITS = 13;
const ACCOUNT_NO_RE = /^[A-Za-z0-9]{1,19}$/;
```

Thay hàm `isValidManualField` (cả chú thích phía trên) bằng:

```js
/** So tai khoan nhap tay: di thang vao duong dan URL nen chi cho chu + so, toi da 19 ky tu. */
function isValidAccountNo(value) {
  return ACCOUNT_NO_RE.test(String(value ?? ''));
}

/**
 * Noi dung chuyen khoan theo chuan VietQR: bo dau tieng Viet, doi ky tu khong phai chu/so thanh
 * dau cach, gop dau cach. KHONG cat do dai — noi goi so voi MAX_TRANSFER_CONTENT va chan neu qua.
 * public/vat-draft/vat-draft.js chep dung quy tac nay.
 */
function normalizeTransferContent(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim();
}
```

Sửa `module.exports`: bỏ `isValidManualField`, thêm `MAX_TRANSFER_CONTENT`, `MAX_AMOUNT_DIGITS`, `normalizeTransferContent`, `isValidAccountNo`:

```js
module.exports = {
  COMMON_BANK_CODES,
  MAX_TRANSFER_CONTENT,
  MAX_AMOUNT_DIGITS,
  getAccountForSource,
  getAccountsForSeller,
  computeSourceAmounts,
  computeTotalAmount,
  formatAccountLabel,
  parseAmountInput,
  buildVietqrImageUrl,
  normalizeTransferContent,
  isValidAccountNo
};
```

- [ ] **Step 8: Chạy test, xác nhận qua**

Run: `cd server && node --test vatDraft/vietqr.test.js vatDraft/vietqrBanks.test.js`
Expected: PASS. (`vatDraftService.js` còn gọi `isValidManualField` — sửa ở Task 2; chưa chạy test route ở bước này.)

- [ ] **Step 9: Commit**

```bash
git add server/vatDraft/vietqrBanks.js server/vatDraft/vietqrBanks.test.js server/vatDraft/vietqr.js server/vatDraft/vietqr.test.js
git commit -m "feat(vat-draft): danh sach ngan hang VietQR + chuan hoa noi dung QR"
```

---

### Task 2: Máy chủ — `/meta` trả ngay, `/master-data/status`, kiểm tra `qrUrl`, bỏ mặc định VCB TKS

**Files:**
- Modify: `server/vatDraft/vatDraftService.js` (hàm `allocate` ~dòng 143–168, `qrUrl` ~189–214, `accountsMeta` ~286–301, phần `require` đầu file)
- Modify: `server/vatDraft/vatDraftRoutes.js` (route `/meta` ~dòng 93–98)
- Test: `server/vatDraft/vatDraftRoutes.test.js`

**Interfaces:**
- Consumes: `findBank`, `VIETQR_BANKS` (Task 1); `vietqr.normalizeTransferContent`, `vietqr.isValidAccountNo`, `vietqr.MAX_TRANSFER_CONTENT`, `vietqr.MAX_AMOUNT_DIGITS` (Task 1).
- Produces (HTTP, trang dùng ở Task 3–5):
  - `GET /api/vat-draft/meta` → `{ vietqr: { template, commonBankCodes, accounts: [...], banks: [{ bin, code, shortName }] } }` cho mọi quyền, không chờ Sheets.
  - `GET /api/vat-draft/master-data/status` (quyền `accounting.vatDraft`) → `{ masterData, sync }`.
  - `POST /api/vat-draft/qr/url` → 400 với `code` `VAT_DRAFT_QR_BANK` | `VAT_DRAFT_QR_ACCOUNT_NO` | `VAT_DRAFT_QR_AMOUNT` | `VAT_DRAFT_QR_CONTENT`; thành công trả `addInfo` đã chuẩn hóa.
  - `POST /allocate` → `qr.bySource[].defaultAccountKey` = key theo `sourceAccountMap` hoặc `null`; `qr.total.defaultAccountKey = null`.

- [ ] **Step 1: Viết test route hỏng**

Trong `server/vatDraft/vatDraftRoutes.test.js`:

(a) Thay toàn bộ test `'GET /meta: trang thai master data, dong bo, danh sach tai khoan'` bằng:

```js
test('GET /meta: chi danh sach tai khoan + ngan hang, tra ngay ke ca khi Google Sheets dang treo', async () => {
  const hanging = { get: () => new Promise(() => {}), refresh: () => new Promise(() => {}) };
  const started = Date.now();
  const res = await request('/meta', { masterData: hanging });
  assert.equal(res.status, 200);
  assert.ok(Date.now() - started < 2000, 'khong cho Sheets');
  assert.deepEqual(Object.keys(res.body), ['vietqr']);
  assert.equal(res.body.vietqr.accounts.length, 18);
  assert.deepEqual(res.body.vietqr.banks.find(b => b.code === 'VCB'), { bin: '970436', code: 'VCB', shortName: 'Vietcombank' });
});

test('GET /master-data/status: trang thai Sheets + dong bo; Sheets loi van 200; sale 403', async () => {
  const res = await request('/master-data/status');
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.masterData.stockRows, res.body.masterData.mappingRows, res.body.masterData.error], [3, 2, null]);
  assert.equal(res.body.sync[0].entity, 'invoices');
  assert.equal(res.body.vietqr, undefined);
  const broken = await request('/master-data/status', { masterData: fakeMaster({ fail: true }) });
  assert.equal(broken.status, 200);
  assert.match(broken.body.masterData.error, /chia sẻ công khai/);
  assert.equal((await request('/master-data/status', { user: userFor(ROLES.NHAN_VIEN_SALE) })).status, 403);
});
```

(b) Thay toàn bộ test `'POST /qr/url'` bằng:

```js
test('POST /qr/url: tai khoan cau hinh, nhap tay doi ve BIN, noi dung chuan hoa', async () => {
  const res = await request('/qr/url', { method: 'POST', body: { accountKey: 'shc', amount: '1.134.000 đ', addInfo: 'HD1 HD2' } });
  assert.equal(res.body.url, 'https://img.vietqr.io/image/MB-525345345-compact2.png?amount=1134000&addInfo=HD1%20HD2&accountName=CONG%20TY%20SHC');
  const manual = await request('/qr/url', { method: 'POST', body: { manual: { bankId: 'acb', accountNo: '123456' }, amount: '0' } });
  assert.equal(manual.status, 200);
  assert.equal(manual.body.url, 'https://img.vietqr.io/image/970416-123456-compact2.png?amount=&addInfo=');
  assert.equal(manual.body.accountLabel, 'ACB - 123456');
  const accented = await request('/qr/url', { method: 'POST', body: { accountKey: 'shc', addInfo: 'Hóa đơn HD1, chị Lan' } });
  assert.equal(accented.body.addInfo, 'Hoa don HD1 chi Lan');
  assert.ok(accented.body.url.includes('addInfo=Hoa%20don%20HD1%20chi%20Lan'));
});

test('POST /qr/url: thieu / sai thong tin -> 400, khong tra URL', async () => {
  const bad = async (body, code) => {
    const res = await request('/qr/url', { method: 'POST', body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.code, code);
    assert.equal(res.body.url, undefined);
  };
  await bad({ accountKey: 'khong_co' }, 'VAT_DRAFT_INVALID');
  await bad({}, 'VAT_DRAFT_INVALID');
  await bad({ manual: { bankId: 'VCB/x', accountNo: '1' } }, 'VAT_DRAFT_QR_BANK');
  await bad({ manual: { bankId: 'Ngân hàng lạ', accountNo: '1' } }, 'VAT_DRAFT_QR_BANK');
  await bad({ manual: { bankId: 'VCB', accountNo: '1'.repeat(20) } }, 'VAT_DRAFT_QR_ACCOUNT_NO');
  await bad({ manual: { bankId: 'VCB', accountNo: '' } }, 'VAT_DRAFT_QR_ACCOUNT_NO');
  await bad({ accountKey: 'shc', amount: '12345678901234' }, 'VAT_DRAFT_QR_AMOUNT');
  await bad({ accountKey: 'shc', addInfo: Array.from({ length: 8 }, (_, i) => `HD02834${i}`).join(' ') }, 'VAT_DRAFT_QR_CONTENT');
  const ok = await request('/qr/url', { method: 'POST', body: { accountKey: 'shc', amount: '9999999999999', addInfo: 'x'.repeat(50) } });
  assert.equal(ok.status, 200, 'dung 13 chu so va dung 50 ky tu van duoc');
});

test('POST /allocate: nguon khong co tai khoan cau hinh va che do gop -> khong chon san tai khoan', async () => {
  const strange = {
    get: async () => ({ ...MASTER, stockRows: [MASTER.stockRows[0], MASTER.stockRows[1], stock(4, 'NGUỒN LẠ', 'VAT02', 'KT3', 100)] }),
    refresh: async () => MASTER
  };
  const res = await request('/allocate', { method: 'POST', masterData: strange, body: { source: 'documents', documents: [{ kind: 'invoice', branch: 'hanoi', code: 'HD1' }, { kind: 'order', branch: 'hanoi', code: 'DH2' }] } });
  assert.equal(res.status, 200);
  const byName = Object.fromEntries(res.body.qr.bySource.map(s => [s.nguon, s.defaultAccountKey]));
  assert.deepEqual(byName, { 'TKS THẤP': 'tks_group', VC: 'mb_vc_ex', 'NGUỒN LẠ': null });
  assert.equal(res.body.qr.total.defaultAccountKey, null);
});
```

- [ ] **Step 2: Chạy test, xác nhận hỏng**

Run: `cd server && node --test vatDraft/vatDraftRoutes.test.js`
Expected: FAIL — `/meta` chờ Sheets treo (test treo tới timeout của `node:test` hoặc `masterData` có trong body), `/master-data/status` 404, `isValidManualField is not a function`, `defaultAccountKey` là `'vcb_tks_group'`.

- [ ] **Step 3: Sửa `vatDraftService.js`**

Thêm `require` cạnh `const vietqr = require('./vietqr');`:

```js
const { VIETQR_BANKS, findBank } = require('./vietqrBanks');
```

Trong `allocate`, thay dòng:

```js
          defaultAccountKey: account && accountKeys.includes(account.key) ? account.key : accountKeys[0] || null,
```

bằng:

```js
          // Nguon khong co trong sourceAccountMap: de trong, bat nguoi dung chon (tranh QR vao nham tai khoan).
          defaultAccountKey: account && accountKeys.includes(account.key) ? account.key : null,
```

và trong khối `total`, thay `defaultAccountKey: accountKeys[0] || null,` bằng:

```js
          // Gop khong VAT: khong co tai khoan mac dinh, nguoi dung tu chon.
          defaultAccountKey: null,
```

Thay toàn bộ hàm `qrUrl` bằng:

```js
  /** Chuc nang 2 — URL anh QR (tai khoan cau hinh hoac nhap tay). Sai chuan VietQR -> 400, khong tra URL. */
  function qrUrl({ accountKey, manual, amount, addInfo } = {}) {
    let account;
    let accountLabel;
    if (manual) {
      const bank = findBank(manual.bankId);
      const accountNo = String(manual.accountNo || '').trim();
      const accountName = String(manual.accountName || '').trim().slice(0, 100);
      if (!bank) throw badRequest('Mã ngân hàng không có trong danh sách VietQR.', 'VAT_DRAFT_QR_BANK');
      if (!vietqr.isValidAccountNo(accountNo)) {
        throw badRequest('Số tài khoản chỉ gồm chữ và số, tối đa 19 ký tự.', 'VAT_DRAFT_QR_ACCOUNT_NO');
      }
      // Dung BIN trong URL: ma nguoi dung go (VCB, vietcombank, 970436) deu ve cung 1 ngan hang.
      account = { bankId: bank.bin, accountNo, accountName };
      accountLabel = `${bank.code} - ${accountNo}${accountName ? ` (${accountName})` : ''}`;
    } else {
      account = config.vietqr.accounts.find(a => a.key === accountKey);
      if (!account) throw badRequest('Tài khoản nhận tiền không hợp lệ.');
      accountLabel = vietqr.formatAccountLabel(account);
    }
    const amountDigits = String(amount ?? '').replace(/[^\d]/g, '').replace(/^0+/, '');
    if (amountDigits.length > vietqr.MAX_AMOUNT_DIGITS) {
      throw badRequest(`Số tiền tối đa ${vietqr.MAX_AMOUNT_DIGITS} chữ số.`, 'VAT_DRAFT_QR_AMOUNT');
    }
    const value = vietqr.parseAmountInput(amountDigits);
    const info = vietqr.normalizeTransferContent(addInfo);
    if (info.length > vietqr.MAX_TRANSFER_CONTENT) {
      throw badRequest(`Nội dung trong QR tối đa ${vietqr.MAX_TRANSFER_CONTENT} ký tự (đang có ${info.length}) — rút gọn bớt.`, 'VAT_DRAFT_QR_CONTENT');
    }
    return {
      url: vietqr.buildVietqrImageUrl(account, { amount: value, addInfo: info, template: config.vietqr.template }),
      amount: value,
      accountLabel,
      addInfo: info
    };
  }
```

Kiểm tra `badRequest(message, code)` ở đầu file nhận tham số `code` (đã có: `function badRequest(message, code = 'VAT_DRAFT_INVALID')`). Nếu `pyStrip` không còn dùng ở đâu khác trong file thì giữ nguyên import (vẫn dùng ở `parseInvoiceImage`).

Trong `accountsMeta`, thêm trường `banks` sau `accounts: ...map(...)`:

```js
      })),
      // Danh sach ngan hang VietQR: trang kiem tra ma ngan hang nhap tay + goi y trong o nhap.
      banks: VIETQR_BANKS.map(({ bin, code, shortName }) => ({ bin, code, shortName }))
```

- [ ] **Step 4: Sửa `vatDraftRoutes.js`**

Thay route `/meta` hiện tại:

```js
  router.get('/meta', ...qrGuard, handle(async (req, res) => {
    // Chi co quyen Tao QR (sale): chi tra danh sach tai khoan, khong lo trang thai Sheets/KiotViet.
    if (!hasFeature(req.user, 'accounting.vatDraft')) return res.json({ vietqr: service.accountsMeta() });
    const [master, sync] = await Promise.all([masterDataStatus(false), repository.syncStatus().catch(() => [])]);
    res.json({ masterData: master, sync, vietqr: service.accountsMeta() });
  }));
```

bằng:

```js
  // Danh sach tai khoan + ngan hang: tra NGAY, khong cho Google Sheets (truoc 13/11/2026 /meta cho
  // doc Sheets toi ~60 giay khi het cache -> o chon tai khoan trong).
  router.get('/meta', ...qrGuard, handle(async (req, res) => {
    res.json({ vietqr: service.accountsMeta() });
  }));

  // Trang thai Sheets / KiotViet cho thanh trang thai tab Xu ly (duoc phep cham).
  router.get('/master-data/status', ...guard, handle(async (req, res) => {
    const [master, sync] = await Promise.all([masterDataStatus(false), repository.syncStatus().catch(() => [])]);
    res.json({ masterData: master, sync });
  }));
```

Nếu `hasFeature` không còn được dùng ở đâu trong file, xóa dòng `const { hasFeature } = require('../auth/featureRegistry');` (kiểm bằng `grep -n hasFeature server/vatDraft/vatDraftRoutes.js`).

- [ ] **Step 5: Chạy test, xác nhận qua**

Run: `cd server && node --test vatDraft/vatDraftRoutes.test.js vatDraft/vietqr.test.js vatDraft/vietqrBanks.test.js`
Expected: PASS toàn bộ. Test `'POST /allocate tu chung tu...'` cũ vẫn qua (TKS THẤP/VC đều có cấu hình).

- [ ] **Step 6: Commit**

```bash
git add server/vatDraft/vatDraftService.js server/vatDraft/vatDraftRoutes.js server/vatDraft/vatDraftRoutes.test.js
git commit -m "fix(vat-draft): /meta tra tai khoan ngay, chan QR sai chuan VietQR"
```

---

### Task 3: Trang — tải tài khoản tách khỏi trạng thái Sheets, tự thử lại

**Files:**
- Modify: `server/public/vat-draft/index.html` (khối `vdManualAccount` ~dòng 241–244)
- Modify: `server/public/vat-draft/vat-draft.js` (`state`, `loadMeta` ~183–191, `renderAccountSelect` ~718–723, `init` ~1470, `bindEvents`)
- Test: `server/test/frontend/vat-draft.test.js`

**Interfaces:**
- Consumes: `GET /meta` → `{ vietqr: { accounts, banks, commonBankCodes } }`; `GET /master-data/status` → `{ masterData, sync }` (Task 2).
- Produces (dùng ở Task 4–5): `state.meta.vietqr` (có `banks`), `state.accountsFailed: boolean`, hàm `accountsLoaded(): boolean`, `renderAccountSelect()`, `loadAccounts(): Promise<void>`, `loadSheetsStatus(): Promise<void>`; hằng `ACCOUNT_RETRY_DELAYS` đọc từ `window.TKSVatDraftRetryDelays` nếu có (test đặt `[0, 0, 0]`).

- [ ] **Step 1: Sửa fixture + harness test, viết test hỏng**

Trong `server/test/frontend/vat-draft.test.js`:

(a) Trong `api()`, thay mục `'GET /meta'` bằng hai mục:

```js
    'GET /meta': { vietqr: { template: 'compact2', commonBankCodes: 'VCB, MB',
      accounts: [{ key: 'tks_group', label: 'MB TKS — MB 606266688888' }, { key: 'shc', label: 'MB SHC — MB 525345345' }],
      banks: [{ bin: '970416', code: 'ACB', shortName: 'ACB' }, { bin: '970436', code: 'VCB', shortName: 'Vietcombank' }, { bin: '970422', code: 'MB', shortName: 'MBBank' }] } },
    'GET /master-data/status': { masterData: { loadedAt: '2026-10-17T02:00:00Z', stale: false, stockRows: 8432, mappingRows: 2998, error: null },
      sync: [{ branch: 'hanoi', entity: 'invoices', syncedAt: new Date().toISOString() }] },
```

(b) Trong `setup`, ngay trước `window.eval(fs.readFileSync(path.join(publicDir, 'vat-draft/cell-select.js'), 'utf8'));` thêm:

```js
  window.TKSVatDraftRetryDelays = [0, 0, 0];
```

và trong `window.fetch` giả, thay `const data = responses[key];` bằng:

```js
    const entry = responses[key];
    const data = typeof entry === 'function' ? entry() : entry;
```

(c) Thêm helper sau `pasteAndRun`:

```js
/** Cho cac promise / setTimeout(0) chay het (tai lai co thu lai). */
async function settle(window) {
  for (let i = 0; i < 20; i += 1) await new Promise(resolve => window.setTimeout(resolve, 0));
}
```

(d) Sửa các test cũ đang dùng `masterData` trong `'GET /meta'`:
- Test `'tai trang: file trung gian loi...'`: thay dòng `const responses = ...` bằng
  ```js
  const responses = { ...base, 'GET /master-data/status': { ...base['GET /master-data/status'], masterData: { ...base['GET /master-data/status'].masterData, fallbackTabs: ['Gộp VAT'] } } };
  ```
- Test `'tai trang: trang thai Sheets/KiotViet...'`: đổi `assert.deepEqual(calls.map(c => c.key), ['GET /meta'], ...)` thành
  ```js
  assert.deepEqual(calls.map(c => c.key), ['GET /meta', 'GET /master-data/status'], 'khong tai danh sach chung tu luc mo trang');
  ```
- Test `'tab Tao QR: nhom tai khoan...'`: giữ nguyên (spread `meta.vietqr` vẫn có `banks`).
- Test `'Nhan vien sale...'`: giữ nguyên (`{ vietqr: api()['GET /meta'].vietqr }`, sale chỉ gọi `GET /meta`).

(e) Thêm test mới cuối file:

```js
test('tai danh sach tai khoan: /meta loi thi tu thu lai; trang thai Sheets loi khong anh huong', async t => {
  let failures = 2;
  const responses = api();
  const meta = responses['GET /meta'];
  responses['GET /meta'] = () => (failures-- > 0 ? undefined : meta);
  delete responses['GET /master-data/status'];
  const { doc, calls } = await setup(t, { hash: '#tao-qr', responses });
  assert.equal(calls.filter(c => c.key === 'GET /meta').length, 3, '2 lan loi + 1 lan thanh cong');
  assert.ok(doc.getElementById('vdManualAccount').querySelector('option[value="tks_group"]'));
  assert.equal(doc.getElementById('vdAccountsRetry').hidden, true);
});

test('tai danh sach tai khoan: het luot thu lai -> bao loi + nut Thu lai; bam Thu lai tai duoc', async t => {
  const responses = api();
  const meta = responses['GET /meta'];
  delete responses['GET /meta'];
  const { doc, window, calls } = await setup(t, { hash: '#tao-qr', responses });
  assert.equal(calls.filter(c => c.key === 'GET /meta').length, 4, '1 lan dau + 3 lan thu lai');
  const select = doc.getElementById('vdManualAccount');
  assert.equal(select.options.length, 1);
  assert.equal(select.options[0].textContent, 'Không tải được danh sách tài khoản');
  assert.equal(doc.getElementById('vdAccountsRetry').hidden, false);
  assert.equal(doc.getElementById('vdManualGenerate').disabled, true);
  assert.match(doc.getElementById('vdQrBlocker').textContent, /Chưa có danh sách tài khoản/);
  responses['GET /meta'] = meta;
  doc.getElementById('vdAccountsRetry').click();
  await settle(window);
  assert.ok(select.querySelector('option[value="tks_group"]'));
  assert.equal(doc.getElementById('vdAccountsRetry').hidden, true);
});
```

Trong test thứ nhất, `delete responses['GET /master-data/status']` làm route đó trả 404: tab Tạo QR vẫn phải có tài khoản.

- [ ] **Step 2: Chạy test, xác nhận hỏng**

Run: `cd server && node --test test/frontend/vat-draft.test.js`
Expected: FAIL — `vdAccountsRetry` null, trạng thái Sheets không hiện (trang chưa gọi `/master-data/status`), số lần gọi `/meta` sai.

- [ ] **Step 3: Sửa `index.html`**

Thay:

```html
                  <select id="vdManualAccount"></select>
```

bằng:

```html
                  <div class="vd-account-select">
                    <select id="vdManualAccount"></select>
                    <button type="button" class="btn-secondary vd-small-btn" id="vdAccountsRetry" hidden>Thử lại</button>
                  </div>
```

Trong `vat-draft.css` thêm (gần `.vd-hint`):

```css
.vd-account-select{display:flex;gap:8px;align-items:center}
.vd-account-select select{flex:1;min-width:0}
.vd-account-select [hidden]{display:none}
```

- [ ] **Step 4: Sửa `vat-draft.js`**

(a) Trong `state` thêm sau `meta: null,`:

```js
    accountsFailed: false,
```

(b) Thay toàn bộ hàm `loadMeta` bằng:

```js
  const ACCOUNT_RETRY_DELAYS = window.TKSVatDraftRetryDelays || [1000, 2000, 4000];
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  function accountsLoaded() {
    return !!(state.meta && state.meta.vietqr);
  }

  /**
   * Danh sach tai khoan + ngan hang (/meta tra ngay, khong cho Google Sheets). Loi thi thu lai
   * theo ACCOUNT_RETRY_DELAYS, het luot thi o chon bao loi + nut Thu lai.
   */
  async function loadAccounts() {
    state.accountsFailed = false;
    $('vdAccountsRetry').hidden = true;
    renderAccountSelect();
    for (let attempt = 0; ; attempt += 1) {
      try {
        const { vietqr } = await api('/meta');
        state.meta = { ...(state.meta || {}), vietqr };
        renderAccountSelect();
        if (state.alloc && state.alloc.qr) renderQr();
        return;
      } catch (error) {
        if (attempt >= ACCOUNT_RETRY_DELAYS.length) break;
        await wait(ACCOUNT_RETRY_DELAYS[attempt]);
      }
    }
    state.accountsFailed = true;
    $('vdAccountsRetry').hidden = false;
    renderAccountSelect();
  }

  /** Trang thai Sheets / KiotViet (chi tab Xu ly) — tai rieng, cham hay loi khong anh huong o tai khoan. */
  async function loadSheetsStatus() {
    try {
      const status = await api('/master-data/status');
      state.meta = { ...(state.meta || {}), ...status };
      renderMeta();
    } catch (error) {
      $('vdSheetsStatus').textContent = error.message;
      setStatusPill('error', 'Không tải được dữ liệu');
    }
  }
```

(c) Thay toàn bộ hàm `renderAccountSelect` bằng:

```js
  function renderAccountSelect() {
    const select = $('vdManualAccount');
    if (!accountsLoaded()) {
      select.innerHTML = `<option value="">${state.accountsFailed ? 'Không tải được danh sách tài khoản' : 'Đang tải danh sách tài khoản…'}</option>`;
    } else {
      select.innerHTML = accountOptions(state.matchedAccounts[0] || select.value || '', { manual: true, placeholder: true, starred: state.matchedAccounts });
      $('vdBankCodes').textContent = 'Mã ngân hàng VietQR thường gặp: ' + state.meta.vietqr.commonBankCodes + '.';
    }
    updateManualFields();
  }
```

(d) Trong `qrFormValues`, thay:

```js
    if (!key) values.reason = 'Chọn tài khoản nhận tiền để tạo QR.';
```

bằng:

```js
    if (!accountsLoaded()) values.reason = 'Chưa có danh sách tài khoản — chờ tải xong hoặc bấm Thử lại.';
    else if (!key) values.reason = 'Chọn tài khoản nhận tiền để tạo QR.';
```

(dòng `else if (manual && !manualFieldsValid())` phía sau giữ nguyên ở Task này).

(e) Trong `bindEvents`, thêm (cạnh `$('vdManualAccount').addEventListener('change', ...)`):

```js
    $('vdAccountsRetry').addEventListener('click', () => { loadAccounts(); });
```

(f) Trong `init`, thay dòng cuối `await loadMeta();` bằng:

```js
    await Promise.all([loadAccounts(), state.canProcess ? loadSheetsStatus() : null]);
```

(g) Tìm mọi chỗ còn gọi `loadMeta` (`grep -n loadMeta server/public/vat-draft/vat-draft.js`) — sau sửa phải không còn.

- [ ] **Step 5: Chạy test, xác nhận qua**

Run: `cd server && node --test test/frontend/vat-draft.test.js`
Expected: PASS toàn bộ (cả test cũ đã sửa ở Step 1d).

- [ ] **Step 6: Commit**

```bash
git add server/public/vat-draft/index.html server/public/vat-draft/vat-draft.css server/public/vat-draft/vat-draft.js server/test/frontend/vat-draft.test.js
git commit -m "fix(vat-draft): tai danh sach tai khoan rieng, tu thu lai, nut Thu lai"
```

---

### Task 4: Trang — tab Tạo QR chặn QR thiếu thông tin

**Files:**
- Modify: `server/public/vat-draft/index.html` (ô `vdManualBank` ~dòng 247, ô `vdManualContent` ~dòng 272–274)
- Modify: `server/public/vat-draft/vat-draft.css`
- Modify: `server/public/vat-draft/vat-draft.js` (tiện ích đầu file, `renderAccountSelect`, `manualFieldsValid`/`updateManualFields` ~725–745, `qrFormValues` ~748–762, `generateManualQr` ~838–872, `window.TKSVatDraft` cuối file)
- Test: `server/test/frontend/vat-draft.test.js`

**Interfaces:**
- Consumes: `state.meta.vietqr.banks`, `accountsLoaded()`, `renderAccountSelect()` (Task 3); `vietqr.normalizeTransferContent` máy chủ (Task 1, để test so khớp).
- Produces (dùng ở Task 5): `MAX_TRANSFER_CONTENT`, `MAX_AMOUNT`, `CONTENT_TOO_LONG`, `AMOUNT_TOO_LONG`, `QR_IMAGE_ERROR` (hằng chuỗi), `normalizeTransferContent(text): string`, `renderContentPreview(input: HTMLInputElement, preview: HTMLElement): { text: string, tooLong: boolean }`, `findBank(value): {bin,code,shortName}|null`; `window.TKSVatDraft.normalizeTransferContent`.

- [ ] **Step 1: Viết test hỏng**

Thêm vào `server/test/frontend/vat-draft.test.js` (đầu file thêm `const vietqr = require('../../vatDraft/vietqr');`):

```js
test('chuan hoa noi dung o trang giong het may chu', async t => {
  const { window } = await setup(t, { hash: '#tao-qr' });
  const samples = ['Hóa đơn HD028345, chị Lan', 'ĐẶNG THỊ ÁNH NGUYỆT', '  HD1   HD2\tDH3  ', 'TT #12/11 (gấp)!', '', 'Ưu đãi — 10% ✓'];
  for (const sample of samples) {
    assert.equal(window.TKSVatDraft.normalizeTransferContent(sample), vietqr.normalizeTransferContent(sample), sample);
  }
});

test('tab Tao QR: noi dung xem truoc + qua 50 ky tu thi khoa nut; so tien de trong van tao duoc', async t => {
  const { doc, window, calls } = await setup(t, { hash: '#tao-qr' });
  const select = doc.getElementById('vdManualAccount');
  select.value = 'shc';
  select.dispatchEvent(new window.Event('change'));
  const content = doc.getElementById('vdManualContent');
  const preview = doc.getElementById('vdManualContentPreview');
  assert.equal(content.hasAttribute('maxlength'), false);
  assert.equal(preview.hidden, true, 'chua nhap thi an');
  content.value = 'Hóa đơn HD1, chị Lan';
  content.dispatchEvent(new window.Event('input'));
  assert.equal(preview.hidden, false);
  assert.equal(preview.textContent, 'Nội dung trong QR: Hoa don HD1 chi Lan (19/50)');
  assert.equal(doc.getElementById('vdManualGenerate').disabled, false, 'so tien trong van tao duoc');
  content.value = Array.from({ length: 8 }, (_, i) => `HD02834${i}`).join(', ');
  content.dispatchEvent(new window.Event('input'));
  assert.equal(preview.dataset.tone, 'warning');
  assert.match(preview.textContent, /\(71\/50\) — tối đa 50 ký tự/);
  assert.equal(doc.getElementById('vdManualGenerate').disabled, true);
  assert.match(doc.getElementById('vdQrBlocker').textContent, /tối đa 50 ký tự/);
  doc.getElementById('vdManualGenerate').click();
  await tick();
  assert.equal(calls.filter(c => c.key === 'POST /qr/url').length, 0, 'khong goi tao QR');
  content.value = 'HD1 HD2';
  content.dispatchEvent(new window.Event('input'));
  doc.getElementById('vdManualGenerate').click();
  await tick(); await tick();
  assert.equal(calls.find(c => c.key === 'POST /qr/url').body.addInfo, 'HD1 HD2');
});

test('tab Tao QR: nhap tay sai ma ngan hang / so TK qua 19 ky tu / so tien qua 13 chu so thi khoa nut', async t => {
  const { doc, window } = await setup(t, { hash: '#tao-qr' });
  const select = doc.getElementById('vdManualAccount');
  select.value = '__manual__';
  select.dispatchEvent(new window.Event('change'));
  const set = (id, value) => { doc.getElementById(id).value = value; doc.getElementById(id).dispatchEvent(new window.Event('input')); };
  const button = doc.getElementById('vdManualGenerate');
  const blocker = doc.getElementById('vdQrBlocker');
  set('vdManualBank', 'Vietcombank');
  set('vdManualNo', '1069579742');
  assert.equal(button.disabled, false, 'ten ngan ngan hang cung hop le');
  assert.ok(doc.querySelector('#vdBankList option[value="VCB"]'), 'goi y ma ngan hang');
  set('vdManualBank', 'Ngân hàng lạ');
  assert.equal(button.disabled, true);
  assert.match(blocker.textContent, /không có trong danh sách VietQR/);
  set('vdManualBank', 'vcb');
  set('vdManualNo', '1'.repeat(20));
  assert.equal(button.disabled, true);
  assert.match(blocker.textContent, /tối đa 19 ký tự/);
  set('vdManualNo', '1069579742');
  set('vdManualAmount', '12345678901234');
  assert.equal(button.disabled, true);
  assert.match(blocker.textContent, /tối đa 13 chữ số/);
  set('vdManualAmount', '1000000');
  assert.equal(button.disabled, false);
});

test('tab Tao QR: anh QR khong tai duoc -> bao loi, an anh va nut Sao chep / Tai', async t => {
  const { doc, window } = await setup(t, { hash: '#tao-qr' });
  const select = doc.getElementById('vdManualAccount');
  select.value = 'tks_group';
  select.dispatchEvent(new window.Event('change'));
  doc.getElementById('vdManualGenerate').click();
  await tick(); await tick();
  assert.equal(doc.getElementById('vdQrPanel').dataset.state, 'success');
  doc.querySelector('#vdManualResult img').dispatchEvent(new window.Event('error'));
  assert.equal(doc.getElementById('vdQrPanel').dataset.state, 'error');
  assert.equal(doc.getElementById('vdQrError').textContent, 'Không tải được ảnh QR từ VietQR — thử lại.');
  assert.equal(doc.getElementById('vdManualResult').hidden, true);
  assert.equal(doc.getElementById('vdQrActions').hidden, true);
  assert.equal(doc.getElementById('vdManualGenerate').disabled, false, 'bam tao lai duoc');
});
```

- [ ] **Step 2: Chạy test, xác nhận hỏng**

Run: `cd server && node --test test/frontend/vat-draft.test.js`
Expected: FAIL — `window.TKSVatDraft.normalizeTransferContent is not a function`, `vdManualContentPreview` null, `#vdBankList` null.

- [ ] **Step 3: Sửa `index.html`**

Thay ô mã ngân hàng:

```html
                  <label>Mã ngân hàng <input type="text" id="vdManualBank" class="vd-input" autocomplete="off" placeholder="VD: VCB, MB, ACB"></label>
```

bằng:

```html
                  <label>Mã ngân hàng <input type="text" id="vdManualBank" class="vd-input" autocomplete="off" placeholder="VD: VCB, MB, ACB" list="vdBankList"></label>
                  <datalist id="vdBankList"></datalist>
```

Thay ô nội dung:

```html
                  <input type="text" id="vdManualContent" class="vd-input" autocomplete="off" maxlength="200" placeholder="VD: mã hóa đơn, tên khách">
```

bằng:

```html
                  <input type="text" id="vdManualContent" class="vd-input" autocomplete="off" placeholder="VD: mã hóa đơn" aria-describedby="vdManualContentPreview">
                  <p class="vd-content-preview" id="vdManualContentPreview" aria-live="polite" hidden></p>
```

Trong `vat-draft.css` thêm:

```css
.vd-content-preview{margin:4px 0 0;font-size:12.5px;color:var(--muted);overflow-wrap:anywhere}
.vd-content-preview[data-tone="warning"]{color:var(--amber);font-weight:600}
.vd-content-preview[hidden]{display:none}
```

- [ ] **Step 4: Thêm tiện ích vào `vat-draft.js`**

Ngay sau hàm `parseAmount` (phần "Tiện ích"), thêm:

```js
  // Gioi han VietQR — cung quy tac voi may chu (server/vatDraft/vietqr.js).
  const MAX_TRANSFER_CONTENT = 50;
  const MAX_AMOUNT = 9999999999999; // 13 chu so
  const CONTENT_TOO_LONG = 'Nội dung trong QR tối đa 50 ký tự — rút gọn bớt.';
  const AMOUNT_TOO_LONG = 'Số tiền tối đa 13 chữ số.';
  const QR_IMAGE_ERROR = 'Không tải được ảnh QR từ VietQR — thử lại.';

  /** Ban sao vietqr.normalizeTransferContent: bo dau, ky tu khong phai chu/so -> dau cach, khong cat. */
  function normalizeTransferContent(text) {
    return String(text ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .replace(/[^A-Za-z0-9]+/g, ' ')
      .trim();
  }

  /** Dong "Nội dung trong QR: … (n/50)" duoi o nhap; tra noi dung da chuan hoa + qua dai hay khong. */
  function renderContentPreview(input, preview) {
    const text = normalizeTransferContent(input.value);
    const tooLong = text.length > MAX_TRANSFER_CONTENT;
    preview.hidden = !text;
    preview.dataset.tone = tooLong ? 'warning' : '';
    preview.textContent = text
      ? `Nội dung trong QR: ${text} (${text.length}/${MAX_TRANSFER_CONTENT})${tooLong ? ' — tối đa 50 ký tự, hãy rút gọn.' : ''}`
      : '';
    return { text, tooLong };
  }

  /** Ngan hang VietQR khop ma / ten ngan / BIN (danh sach tu /meta), khong phan biet hoa/thuong. */
  function findBank(value) {
    const target = String(value ?? '').trim().toLowerCase();
    const banks = (state.meta && state.meta.vietqr && state.meta.vietqr.banks) || [];
    if (!target) return null;
    return banks.find(bank => [bank.bin, bank.code, bank.shortName].some(v => String(v).toLowerCase() === target)) || null;
  }
```

- [ ] **Step 5: Sửa kiểm tra nhập tay, form và tạo QR trong `vat-draft.js`**

(a) Trong `renderAccountSelect` (Task 3), nhánh `else`, sau dòng `$('vdBankCodes').textContent = ...` thêm:

```js
      $('vdBankList').innerHTML = (state.meta.vietqr.banks || [])
        .map(bank => `<option value="${escapeHtml(bank.code)}">${escapeHtml(bank.shortName)}</option>`).join('');
```

(b) Thay hàm `manualFieldsValid` (cả chú thích) bằng:

```js
  /** Ly do o nhap tay chua hop le ('' = hop le). Cung quy tac voi may chu (findBank + isValidAccountNo). */
  function manualFieldsReason() {
    const bank = $('vdManualBank').value.trim();
    const accountNo = $('vdManualNo').value.trim();
    if (!bank || !accountNo) return 'Nhập đủ Mã ngân hàng và Số tài khoản.';
    if (!findBank(bank)) return 'Mã ngân hàng không có trong danh sách VietQR.';
    if (!/^[A-Za-z0-9]{1,19}$/.test(accountNo)) return 'Số tài khoản chỉ gồm chữ và số, tối đa 19 ký tự.';
    return '';
  }
```

(c) Trong `updateManualFields`, thay dòng:

```js
    $('vdManualInvalid').hidden = !(manual && state.manualTouched && !manualFieldsValid());
```

bằng:

```js
    const manualReason = manual ? manualFieldsReason() : '';
    $('vdManualInvalid').hidden = !(state.manualTouched && manualReason);
    if (manualReason) $('vdManualInvalid').textContent = manualReason;
```

(d) Thay toàn bộ hàm `qrFormValues` bằng:

```js
  /** Gia tri form Tao QR + ly do chua tao duoc; key dung de biet QR da tao con dung voi form khong. */
  function qrFormValues() {
    const key = $('vdManualAccount').value;
    const manual = key === MANUAL;
    const content = renderContentPreview($('vdManualContent'), $('vdManualContentPreview'));
    const values = {
      accountKey: manual || !key ? undefined : key,
      manual: manual ? { bankId: $('vdManualBank').value.trim(), accountNo: $('vdManualNo').value.trim(), accountName: $('vdManualName').value.trim() } : undefined,
      amount: parseAmount($('vdManualAmount').value),
      addInfo: content.text,
      reason: '',
      focus: null
    };
    const manualReason = manual ? manualFieldsReason() : '';
    if (!accountsLoaded()) values.reason = 'Chưa có danh sách tài khoản — chờ tải xong hoặc bấm Thử lại.';
    else if (!key) { values.reason = 'Chọn tài khoản nhận tiền để tạo QR.'; values.focus = 'vdManualAccount'; }
    else if (manualReason) { values.reason = manualReason; values.focus = 'vdManualBank'; }
    else if (values.amount > MAX_AMOUNT) { values.reason = AMOUNT_TOO_LONG; values.focus = 'vdManualAmount'; }
    else if (content.tooLong) { values.reason = CONTENT_TOO_LONG; values.focus = 'vdManualContent'; }
    values.key = JSON.stringify([key, values.manual || null, values.amount, values.addInfo]);
    return values;
  }
```

(e) Trong `generateManualQr`, thay khối đầu:

```js
    if (values.reason) {
      state.manualTouched = true;
      updateManualFields();
      ($('vdManualAccount').value === MANUAL ? $('vdManualBank') : $('vdManualAccount')).focus();
      return;
    }
```

bằng:

```js
    if (values.reason) {
      state.manualTouched = true;
      updateManualFields();
      if (values.focus) $(values.focus).focus();
      return;
    }
```

(f) Trong `generateManualQr`, ngay sau khối gán `$('vdManualResult').innerHTML = \`<figure class="vd-qr-figure">…\`;` (vẫn trong `try`), thêm:

```js
      // Anh do img.vietqr.io tra: tai loi (mang / VietQR tu choi) thi bao loi, khong de khung anh vo.
      $('vdManualResult').querySelector('img').addEventListener('error', () => {
        if (state.qr.status !== 'done' || state.qr.url !== data.url) return;
        state.qr = { status: 'error', key: values.key, error: QR_IMAGE_ERROR };
        $('vdManualResult').innerHTML = '';
        refreshQrPanel();
      });
```

(g) Cuối file, thêm `normalizeTransferContent` vào `window.TKSVatDraft`:

```js
  window.TKSVatDraft = { init, pyFloatRepr, csvCell, formatAmount, parseAmount, slug, normalizeTransferContent, state };
```

(h) `grep -n manualFieldsValid server/public/vat-draft/vat-draft.js` — phải không còn kết quả.

- [ ] **Step 6: Chạy test, xác nhận qua**

Run: `cd server && node --test test/frontend/vat-draft.test.js`
Expected: PASS toàn bộ. Test cũ `'tab Tao QR: tai khoan nhap tay can du ma ngan hang + so TK...'` qua vì fixture có `ACB`.

- [ ] **Step 7: Commit**

```bash
git add server/public/vat-draft/index.html server/public/vat-draft/vat-draft.css server/public/vat-draft/vat-draft.js server/test/frontend/vat-draft.test.js
git commit -m "fix(vat-draft): tab Tao QR chan noi dung/ngan hang/so tien sai chuan VietQR"
```

---

### Task 5: Trang — thẻ QR tab Xử lý bắt chọn tài khoản + chặn nội dung quá dài

**Files:**
- Modify: `server/public/vat-draft/index.html` (ô `vdTransfer` ~dòng 172–174)
- Modify: `server/public/vat-draft/vat-draft.js` (`qrCardHtml` ~614–623, `renderQr` ~625–642, `generateQr` ~644–662, `bindEvents` khối `vdTransfer` / `vdQrCards` ~1361–1385)
- Test: `server/test/frontend/vat-draft.test.js`

**Interfaces:**
- Consumes: `MAX_AMOUNT`, `CONTENT_TOO_LONG`, `AMOUNT_TOO_LONG`, `QR_IMAGE_ERROR`, `renderContentPreview` (Task 4); `accountOptions(selectedKey, { placeholder })` (có sẵn); `defaultAccountKey: null` từ `/allocate` (Task 2).
- Produces: `refreshQrCards(): { text: string, tooLong: boolean }`.

- [ ] **Step 1: Viết test hỏng**

Thêm vào `server/test/frontend/vat-draft.test.js`:

```js
test('xu ly chung tu: nguon khong co tai khoan cau hinh / che do gop -> o tai khoan trong, nut tao QR khoa', async t => {
  const responses = api();
  const alloc = responses['POST /allocate'];
  responses['POST /allocate'] = { ...alloc, qr: { ...alloc.qr,
    bySource: [alloc.qr.bySource[0], { ...alloc.qr.bySource[1], nguon: 'NGUỒN LẠ', defaultAccountKey: null }],
    total: { ...alloc.qr.total, defaultAccountKey: null } } };
  const { doc, window, calls } = await setup(t, { responses });
  await pasteAndRun(doc);
  const cards = doc.querySelectorAll('[data-qr-card]');
  assert.equal(cards[0].querySelector('[data-qr-account]').value, 'tks_group');
  assert.equal(cards[0].querySelector('[data-qr-generate]').disabled, false);
  const strange = cards[1];
  assert.equal(strange.querySelector('[data-qr-account]').value, '');
  assert.equal(strange.querySelector('[data-qr-account] option').textContent, '— Chọn tài khoản nhận tiền —');
  assert.equal(strange.querySelector('[data-qr-generate]').disabled, true);
  assert.equal(strange.querySelector('[data-qr-reason]').textContent, 'Chọn tài khoản nhận tiền.');
  const select = strange.querySelector('[data-qr-account]');
  select.value = 'shc';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(strange.querySelector('[data-qr-generate]').disabled, false);
  assert.equal(strange.querySelector('[data-qr-reason]').hidden, true);
  doc.querySelector('[data-qr-mode="khong_vat"]').click();
  assert.equal(doc.querySelector('[data-qr-account]').value, '');
  assert.equal(doc.querySelector('[data-qr-generate]').disabled, true);
  assert.equal(calls.filter(c => c.key === 'POST /qr/url').length, 0);
});

test('xu ly chung tu: noi dung chuyen khoan qua 50 ky tu -> moi nut tao QR khoa; anh QR loi -> bao loi', async t => {
  const { doc, window } = await setup(t);
  await pasteAndRun(doc);
  const transfer = doc.getElementById('vdTransfer');
  const preview = doc.getElementById('vdTransferPreview');
  assert.equal(preview.textContent, 'Nội dung trong QR: HD028345 DH050000 (17/50)');
  transfer.value = Array.from({ length: 8 }, (_, i) => `HD02834${i}`).join(' ');
  transfer.dispatchEvent(new window.Event('input'));
  assert.equal(preview.dataset.tone, 'warning');
  for (const button of doc.querySelectorAll('[data-qr-generate]')) assert.equal(button.disabled, true);
  assert.equal(doc.querySelector('[data-qr-reason]').textContent, 'Nội dung trong QR tối đa 50 ký tự — rút gọn bớt.');
  transfer.value = 'HD028345';
  transfer.dispatchEvent(new window.Event('input'));
  const card = doc.querySelector('[data-qr-card]');
  card.querySelector('[data-qr-generate]').click();
  await tick(); await tick();
  card.querySelector('[data-qr-result] img').dispatchEvent(new window.Event('error'));
  assert.equal(card.querySelector('[data-qr-result]').textContent.trim(), 'Không tải được ảnh QR từ VietQR — thử lại.');
  assert.equal(card.querySelector('[data-qr-download]'), null);
});
```

- [ ] **Step 2: Chạy test, xác nhận hỏng**

Run: `cd server && node --test test/frontend/vat-draft.test.js`
Expected: FAIL — ô tài khoản thẻ thứ 2 chọn sẵn `tks_group` (không có placeholder), `vdTransferPreview` null, `[data-qr-reason]` null.

- [ ] **Step 3: Sửa `index.html`**

Thay:

```html
          <input type="text" id="vdTransfer" class="vd-input" autocomplete="off">
```

bằng:

```html
          <input type="text" id="vdTransfer" class="vd-input" autocomplete="off" aria-describedby="vdTransferPreview">
          <p class="vd-content-preview" id="vdTransferPreview" aria-live="polite" hidden></p>
```

- [ ] **Step 4: Sửa `vat-draft.js`**

(a) Thay toàn bộ hàm `qrCardHtml` bằng:

```js
  function qrCardHtml(id, title, amount, accountKey, warning) {
    return `<div class="vd-qr-card" data-qr-card="${id}">
      <h5>${escapeHtml(title)}</h5>
      ${warning ? `<p class="vd-message vd-warning">${ICON.warn} Một số dòng thiếu Giá bán/Giá nhập, số tiền QR có thể chưa đầy đủ.</p>` : ''}
      <label>Tài khoản nhận tiền <select data-qr-account>${accountOptions(accountKey || '', { placeholder: true })}</select></label>
      <label>Số tiền <input type="text" class="vd-input" data-qr-amount inputmode="numeric" value="${escapeHtml(formatAmount(amount))}"></label>
      <p class="vd-message vd-warning" data-qr-reason hidden></p>
      <button class="btn-primary" type="button" data-qr-generate>${ICON.qr}Tạo mã QR — ${escapeHtml(intFormat.format(amount))}đ</button>
      <div class="vd-qr-result" data-qr-result hidden></div>
    </div>`;
  }

  /** Khoa nut Tao ma QR tung the khi chua chon tai khoan / so tien qua 13 chu so / noi dung qua 50 ky tu. */
  function refreshQrCards() {
    const content = renderContentPreview($('vdTransfer'), $('vdTransferPreview'));
    document.querySelectorAll('#vdQrCards [data-qr-card]').forEach(card => {
      const reason = !card.querySelector('[data-qr-account]').value ? 'Chọn tài khoản nhận tiền.'
        : parseAmount(card.querySelector('[data-qr-amount]').value) > MAX_AMOUNT ? AMOUNT_TOO_LONG
          : content.tooLong ? CONTENT_TOO_LONG : '';
      card.querySelector('[data-qr-generate]').disabled = !!reason;
      const note = card.querySelector('[data-qr-reason]');
      note.hidden = !reason;
      note.textContent = reason;
    });
    return content;
  }
```

(b) Trong `renderQr`, thêm `refreshQrCards();` làm dòng cuối của hàm (sau khối `if (state.qrMode === 'co_vat') { … } else { … }`).

(c) Trong `generateQr`, sau ba dòng `figure.dataset.… = …;` (vẫn trong `try`) thêm:

```js
      resultEl.querySelector('img').addEventListener('error', () => {
        resultEl.innerHTML = `<p class="vd-message vd-error">${escapeHtml(QR_IMAGE_ERROR)}</p>`;
      });
```

(d) Trong `bindEvents`, thay:

```js
    $('vdTransfer').addEventListener('input', () => { $('vdTransferHint').hidden = !!$('vdTransfer').value.trim(); });
    $('vdQrCards').addEventListener('change', event => {
      if (!event.target.matches('[data-qr-amount]')) return;
      event.target.value = formatAmount(parseAmount(event.target.value));
    });
    $('vdQrCards').addEventListener('input', event => {
      if (!event.target.matches('[data-qr-amount]')) return;
      const card = event.target.closest('[data-qr-card]');
      card.querySelector('[data-qr-generate]').innerHTML = `${ICON.qr}Tạo mã QR — ${intFormat.format(parseAmount(event.target.value))}đ`;
    });
```

bằng:

```js
    $('vdTransfer').addEventListener('input', () => {
      $('vdTransferHint').hidden = !!$('vdTransfer').value.trim();
      refreshQrCards();
    });
    $('vdQrCards').addEventListener('change', event => {
      if (event.target.matches('[data-qr-amount]')) event.target.value = formatAmount(parseAmount(event.target.value));
      if (event.target.matches('[data-qr-amount], [data-qr-account]')) refreshQrCards();
    });
    $('vdQrCards').addEventListener('input', event => {
      if (!event.target.matches('[data-qr-amount]')) return;
      const card = event.target.closest('[data-qr-card]');
      card.querySelector('[data-qr-generate]').innerHTML = `${ICON.qr}Tạo mã QR — ${intFormat.format(parseAmount(event.target.value))}đ`;
      refreshQrCards();
    });
```

(e) Trong handler `click` của `vdQrCards` (gọi `generateQr`), thay `addInfo: $('vdTransfer').value.trim(),` bằng:

```js
        addInfo: refreshQrCards().text,
```

và ngay sau `if (!button) return;` thêm `if (button.disabled) return;`.

- [ ] **Step 5: Chạy test, xác nhận qua**

Run: `cd server && node --test test/frontend/vat-draft.test.js`
Expected: PASS toàn bộ. Test cũ `'xu ly chung tu: ... QR dien san ma chung tu'` qua vì fixture `total.defaultAccountKey = 'tks_group'` và nội dung 17 ký tự.

- [ ] **Step 6: Commit**

```bash
git add server/public/vat-draft/index.html server/public/vat-draft/vat-draft.js server/test/frontend/vat-draft.test.js
git commit -m "fix(vat-draft): the QR tab Xu ly bat chon tai khoan, chan noi dung qua 50 ky tu"
```

---

### Task 6: Kiểm tra toàn bộ, chạy thử, tài liệu

**Files:**
- Modify: `server/README.md` (đoạn mô tả Nháp VAT dòng ~205, bảng API dòng ~213 và ~219, ghi chú dòng ~1411)
- Modify: `README.md` (dòng "Cập nhật gần nhất" cuối mục liên quan + danh sách cập nhật gần nhất)
- Modify: `docs/02-srs/SRS_Dashboard_GoogleSheets.md` (sau FR-VAT-8 ~dòng 756)
- Modify: `docs/04-planning/implementation_plan.md` (sau dòng 19/10/2026 Workspace Tạo QR ~dòng 185)
- Modify: `CURRENT.md`

**Interfaces:**
- Consumes: toàn bộ Task 1–5.

- [ ] **Step 1: Chạy test liên quan**

Run: `cd server && node --test vatDraft/vietqr.test.js vatDraft/vietqrBanks.test.js vatDraft/vatDraftRoutes.test.js test/frontend/vat-draft.test.js`
Expected: PASS 100%.

Tìm các nơi khác dùng `/api/vat-draft/meta` hoặc `isValidManualField`:

Run: `grep -rn "vat-draft/meta\|isValidManualField\|accountsMeta" server --include=*.js | grep -v node_modules`
Expected: chỉ còn `vatDraftRoutes.js`, `vatDraftService.js`, các file test đã sửa. Nếu module khác (vd. `vatLookup`, `shared-nav.js`) gọi `/api/vat-draft/meta` để lấy `masterData` → chuyển sang `/api/vat-draft/master-data/status` và chạy test của module đó.

- [ ] **Step 2: Chạy toàn bộ test thư mục vatDraft + frontend**

Run: `cd server && node --test "vatDraft/**/*.test.js" "test/frontend/*.test.js"`
Expected: PASS, không có lỗi mới so với `main` (nếu có test hỏng sẵn trên `main`, chạy lại test đó trên `main` để xác nhận không do thay đổi này).

- [ ] **Step 3: Chạy thử trên server local (chế độ chỉ đọc)**

Dùng `preview_start` với cấu hình trong `.claude/launch.json` (readonly: sync tắt, pool 3). Đăng nhập tài khoản test, mở `/vat-draft/#tao-qr`:
1. Ô "Tài khoản nhận tiền" có danh sách ngay khi mở trang (không chờ dòng trạng thái Sheets).
2. Chọn `MB SHC`, nhập nội dung `Hóa đơn HD1, chị Lan` → dòng "Nội dung trong QR: Hoa don HD1 chi Lan (19/50)"; bấm Tạo mã QR → ảnh QR hiện, URL có `addInfo=Hoa%20don%20HD1%20chi%20Lan`.
3. Nhập nội dung 8 mã hóa đơn → nút khóa, dòng xem trước màu cảnh báo.
4. Chọn "Tài khoản khác", mã ngân hàng `Vietcombank`, số TK `1069579742` → tạo được; URL bắt đầu `https://img.vietqr.io/image/970436-1069579742-`.
5. `read_console_messages` không có lỗi. Chụp màn hình làm bằng chứng.

- [ ] **Step 4: Cập nhật tài liệu**

`server/README.md`:
- Đoạn mô tả Nháp VAT (~dòng 205): thay `Route Tạo QR (\`/meta\`, \`/qr/url\`, …) … tài khoản chỉ có \`accounting.qr\` nhận \`/meta\` rút gọn \`{ vietqr }\`` thành: `Route Tạo QR (\`/meta\`, \`/qr/url\`, \`/qr/parse-text\`, \`/qr/parse-image\`) nhận \`accounting.vatDraft\` **hoặc** \`accounting.qr\`; \`/meta\` chỉ trả \`{ vietqr }\` (tài khoản + ngân hàng VietQR) và trả ngay, không chờ Google Sheets.`
- Bảng API: thay dòng `GET /api/vat-draft/meta` bằng hai dòng:
  ```
  | GET | `/api/vat-draft/meta` | (`accounting.vatDraft` hoặc `accounting.qr`) `{ vietqr: { template, commonBankCodes, accounts, banks } }` — trả ngay, không đọc Google Sheets |
  | GET | `/api/vat-draft/master-data/status` | (`accounting.vatDraft`) `{ masterData, sync }`: trạng thái master data (số dòng, lúc tải, stale, lỗi, `fallbackTabs`) + mốc đồng bộ KiotViet |
  ```
- Dòng `POST /api/vat-draft/qr/url`: thêm `; kiểm tra chuẩn VietQR — mã ngân hàng nhập tay phải có trong \`vatDraft/vietqrBanks.js\` (URL dùng BIN), số TK ≤ 19 chữ/số, số tiền ≤ 13 chữ số, nội dung bỏ dấu/ký tự đặc biệt và ≤ 50 ký tự; sai → 400 (\`VAT_DRAFT_QR_BANK\`, \`VAT_DRAFT_QR_ACCOUNT_NO\`, \`VAT_DRAFT_QR_AMOUNT\`, \`VAT_DRAFT_QR_CONTENT\`)`.
- Ghi chú `fallbackTabs` (~dòng 1411): đổi `Meta \`/api/vat-draft/meta\`` thành `\`/api/vat-draft/master-data/status\``.
- Thêm mục lịch sử mới (cùng kiểu mục 19/10/2026 ~dòng 549): `13/11/2026 — **Sửa lỗi tạo mã QR** (không migration): \`/meta\` tách khỏi đọc Sheets (thêm \`/master-data/status\`), trang tự thử lại tải tài khoản + nút Thử lại; QR chỉ tạo khi đủ thông tin hợp lệ chuẩn VietQR (nội dung ≤ 50 ký tự sau bỏ dấu, ngân hàng trong danh sách, số TK ≤ 19, số tiền ≤ 13 chữ số); ảnh QR lỗi tải thì báo lỗi; tab Xử lý không còn tự chọn VCB TKS cho nguồn không cấu hình / chế độ gộp.` Cập nhật ngày "Cập nhật" cuối file thành 13/11/2026.

`docs/02-srs/SRS_Dashboard_GoogleSheets.md`: sau FR-VAT-8 thêm:

```
- **FR-VAT-9 (Chặn QR thiếu thông tin, 13/11/2026)**: danh sách tài khoản nhận tiền tải riêng (`GET /meta`), không chờ Google Sheets; lỗi thì tự thử lại 3 lần rồi hiện nút Thử lại. Mã QR chỉ được tạo khi: đã chọn tài khoản (tài khoản cấu hình, hoặc nhập tay với mã ngân hàng có trong danh sách VietQR và số TK 1–19 chữ/số); nội dung chuyển khoản sau khi bỏ dấu và ký tự đặc biệt không quá 50 ký tự (quá thì chặn, không tự cắt; trang hiện "Nội dung trong QR: … (n/50)"); số tiền để trống (người chuyển tự nhập) hoặc tối đa 13 chữ số. Ảnh QR không tải được thì báo lỗi, ẩn nút Sao chép/Tải. Tab Xử lý: nguồn không có trong `sourceAccountMap` và chế độ gộp không VAT để trống ô tài khoản, bắt chọn tay.
```

`docs/04-planning/implementation_plan.md`: sau dòng `19/10/2026 — **Workspace Tạo QR**…` thêm:

```
13/11/2026 — **Sửa lỗi tạo mã QR**: `GET /api/vat-draft/meta` chỉ trả `{ vietqr }` (thêm `banks`) và không đọc Sheets; trạng thái Sheets/KiotViet chuyển sang `GET /api/vat-draft/master-data/status`. `vatDraft/vietqrBanks.js` (danh sách ngân hàng VietQR tĩnh, `findBank`), `vietqr.normalizeTransferContent` / `isValidAccountNo` (trang chép cùng quy tắc, test so khớp). `service.qrUrl` trả 400 khi sai chuẩn VietQR; `allocate` không còn mặc định tài khoản đầu danh sách. Spec: `docs/superpowers/specs/2026-11-13-vietqr-generation-fixes-design.md`.
```

`README.md`: thêm 1 dòng vào danh sách cập nhật gần nhất: `13/11/2026 — Nháp VAT: sửa lỗi tạo mã QR (danh sách tài khoản tải ngay, chặn QR sai chuẩn VietQR).` và đổi ngày cập nhật cuối file thành 13/11/2026.

`CURRENT.md`: thêm 1 dòng (việc còn dở thuộc người dùng):

```
- [ ] 13/11 — Nháp VAT: tài khoản VIB QUÂN số `044345` (6 số, ngắn bất thường) — hỏi người phụ trách; sai thì sửa `server/vatDraft/vatDraftConfig.js`
```

và đổi dòng `Cập nhật:` cuối file thành `13/11/2026`.

- [ ] **Step 5: Commit**

```bash
git add README.md server/README.md docs/02-srs/SRS_Dashboard_GoogleSheets.md docs/04-planning/implementation_plan.md CURRENT.md
git commit -m "docs(vat-draft): cap nhat tai lieu sua loi tao ma QR"
```

- [ ] **Step 6: Cập nhật đồ thị graphify (chỉ máy local, không commit)**

Run: `graphify update .`
Expected: chạy xong, `graphify-out/` không xuất hiện trong `git status`.
