'use strict';

// Port src/vietqr.py: anh QR VietQR qua Quick Link (img.vietqr.io, khong can API key),
// tong tien theo NGUON (hoa don co VAT: theo Gia nhap) hoac gop (khong VAT: theo Gia ban).

const { pyRound, pyQuote } = require('./pyCompat');
const { normalizeCodeForMatch, normalizeDiacriticsInsensitive, toFloatOrNone } = require('./normalization');
const vatDraftConfig = require('./vatDraftConfig');

const VIETQR_IMAGE_BASE = 'https://img.vietqr.io/image';
const COMMON_BANK_CODES = 'VCB (Vietcombank), MB (MBBank), ACB, TPB (TPBank), VIB, SHB, '
  + 'VPB (VPBank), MSB, OCB, BIDV, TCB (Techcombank), AGRIBANK, '
  + 'STB (Sacombank), VBA, ICB (VietinBank)';
// Gioi han cua VietQR Quick Link: addInfo toi da 50 ky tu khong ky tu dac biet, so TK toi da 19
// chu/so, so tien toi da 13 chu so. Vuot gioi han thi anh van ra nhung app ngan hang tu choi.
const MAX_TRANSFER_CONTENT = 50;
const MAX_AMOUNT_DIGITS = 13;
const ACCOUNT_NO_RE = /^[A-Za-z0-9]{1,19}$/;

function accountsByKey(config = vatDraftConfig) {
  return new Map(config.vietqr.accounts.map(account => [account.key, account]));
}

/** Tai khoan cau hinh cho mot nguon (khong phan biet hoa/thuong). */
function getAccountForSource(nguon, config = vatDraftConfig) {
  const target = normalizeCodeForMatch(nguon);
  const accounts = accountsByKey(config);
  for (const [sourceName, accountKey] of Object.entries(config.vietqr.sourceAccountMap || {})) {
    if (normalizeCodeForMatch(sourceName) === target) return accounts.get(accountKey) || null;
  }
  return null;
}

/** Tai khoan cong ty khop "Don vi ban hang" tren hoa don PDF (chua chuoi, bo dau, khong hoa/thuong). */
function getAccountsForSeller(sellerName, config = vatDraftConfig) {
  if (!sellerName) return [];
  const target = normalizeDiacriticsInsensitive(sellerName);
  const matchedKeys = [];
  for (const rule of config.vietqr.sellerAccountMap || []) {
    if (rule.match.some(keyword => target.includes(normalizeDiacriticsInsensitive(keyword)))) {
      for (const key of rule.accounts) if (!matchedKeys.includes(key)) matchedKeys.push(key);
    }
  }
  const accounts = accountsByKey(config);
  return matchedKeys.filter(key => accounts.has(key)).map(key => accounts.get(key));
}

function emptyAmount(nguon) {
  return { nguon, soDong: 0, tongGiaBan: 0.0, tongGiaNhap: 0.0, thieuDonGia: false };
}

function addLine(amount, line) {
  const giaBan = toFloatOrNone(line.giaBan);
  amount.soDong += 1;
  if (giaBan === null || line.giaNhap === null || line.giaNhap === undefined) {
    amount.thieuDonGia = true;
    return;
  }
  amount.tongGiaBan += giaBan * line.slPhanBo;
  amount.tongGiaNhap += line.giaNhap * line.slPhanBo;
}

/** Gop dong ket qua (OK) theo NGUON -> Map(nguon -> tong Gia ban / Gia nhap). */
function computeSourceAmounts(lines) {
  const totals = new Map();
  for (const line of lines || []) {
    if (!totals.has(line.nguon)) totals.set(line.nguon, emptyAmount(line.nguon));
    addLine(totals.get(line.nguon), line);
  }
  return totals;
}

/** Gop toan bo dong ket qua bat ke nguon (QR hoa don KHONG VAT). */
function computeTotalAmount(lines) {
  const total = emptyAmount('TẤT CẢ NGUỒN');
  for (const line of lines || []) addLine(total, line);
  return total;
}

/** Nhan tai khoan nhu _format_account cua app cu. */
function formatAccountLabel(account) {
  const base = account.label || `${account.bankId} - ${account.accountNo}`;
  const label = account.label ? `${base} — ${account.bankId} ${account.accountNo}` : base;
  return account.accountName ? `${label} (${account.accountName})` : label;
}

/** Doc lai so tien tu o nhap (bo moi ky tu khong phai so). */
function parseAmountInput(text) {
  const digits = String(text || '').replace(/[^\d]/g, '');
  return digits ? Number(digits) : 0;
}

/** URL anh QR (Quick Link). amount <= 0 -> de trong de nguoi chuyen tu nhap. */
function buildVietqrImageUrl(account, { amount, addInfo, template = vatDraftConfig.vietqr.template }) {
  const amountStr = amount && amount > 0 ? String(pyRound(amount)) : '';
  let query = `amount=${amountStr}&addInfo=${pyQuote(addInfo || '')}`;
  if (account.accountName) query += `&accountName=${pyQuote(account.accountName)}`;
  return `${VIETQR_IMAGE_BASE}/${account.bankId}-${account.accountNo}-${template}.png?${query}`;
}

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
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim();
}

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
