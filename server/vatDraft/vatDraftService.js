'use strict';

// Ghep dau vao (chung tu chon tu DB hoac du lieu dan tay) -> thuat toan port tu vat-draft-app
// -> payload cho trang Nhap VAT. Chung tu tu DB duoc dua ve DUNG 7 truong ma app cu doc tu
// file "Danh sach chi tiet hoa don" (Ma hang, Ten hang, So luong, Gia ban, Ghi chu hang hoa,
// Ma hoa don, Thanh tien), cong them "Ghi chu tong" chi gan o buoc hien thi.

const { pyStrip, pyRound } = require('./pyCompat');
const { allocateInvoiceSources, buildUnifiedColumns, buildUnifiedDisplayRows } = require('./allocation');
const { parseInvoicePasteRows, rowsToQueries, parseDocumentCodes } = require('./pasteParser');
const vietqr = require('./vietqr');
const { parseInvoiceAmount, parseInvoiceText } = require('./invoicePdfText');
const { parseVietnameseAmountWords } = require('./amountWords');
const vatDraftConfig = require('./vatDraftConfig');

const MAX_DOCUMENTS = 200;
const MAX_LINES = 5000;
const MAX_PASTE_CHARS = 2 * 1024 * 1024;

function badRequest(message, code = 'VAT_DRAFT_INVALID') {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  return error;
}

function masterDataMeta(snapshot) {
  return {
    loadedAt: snapshot.loadedAt ? new Date(snapshot.loadedAt).toISOString() : null,
    stale: !!snapshot.stale,
    fallbackTabs: snapshot.fallbackTabs || [],
    stockRows: snapshot.stockRows.length,
    mappingRows: snapshot.mappingRows.length,
    invalidStockRows: (snapshot.warnings || []).length
  };
}

function normalizeSelections(documents) {
  if (!Array.isArray(documents) || !documents.length) throw badRequest('Chưa chọn chứng từ nào.');
  if (documents.length > MAX_DOCUMENTS) throw badRequest(`Mỗi lần xử lý tối đa ${MAX_DOCUMENTS} chứng từ.`);
  return documents.map(d => ({
    kind: String(d && d.kind || ''),
    branch: String(d && d.branch || ''),
    code: String(d && d.code || '').trim().toUpperCase()
  }));
}

/** Chung tu -> query thuat toan (bo dong khong co Ma hang nhu bo doc file cu) + Ghi chu tong theo dong. */
function documentsToQueries(docs) {
  const queries = [];
  const extraByOrder = new Map();
  for (const doc of docs) {
    for (const line of doc.lines) {
      const maSp = pyStrip(line.productCode);
      if (!maSp) continue;
      const orderIndex = queries.length + 1;
      queries.push({
        orderIndex,
        maSp,
        tenSp: pyStrip(line.productName),
        sl: pyStrip(line.quantity),
        giaBan: pyStrip(line.unitPrice),
        ghiChuHangHoa: pyStrip(line.note),
        maHoaDon: doc.code,
        thanhTien: pyStrip(line.lineTotal)
      });
      extraByOrder.set(orderIndex, { 'Ghi chú tổng': pyStrip(doc.docNote || '') });
    }
  }
  if (queries.length > MAX_LINES) throw badRequest(`Quá ${MAX_LINES} dòng hàng mỗi lần xử lý. Hãy chọn ít chứng từ hơn.`);
  return { queries, extraByOrder };
}

function pasteText(text) {
  const value = typeof text === 'string' ? text : '';
  if (value.length > MAX_PASTE_CHARS) throw badRequest('Dữ liệu dán quá lớn.');
  return value;
}

const vnd = new Intl.NumberFormat('vi-VN');

/**
 * Tong thanh toan AI doc tu chu so co the nham 1 chu so (3 -> 5). Doi chieu voi 2 nguon doc lap
 * tren cung hoa don: Cong tien hang + Thue, va So tien bang chu (tu doi sang so, khong qua AI).
 * status: 'ok' (tong khop it nhat 1 nguon), 'corrected' (2 nguon kia khop nhau, dung so bang chu),
 * 'unverified' (khong doi chieu duoc) -> trang bat nguoi dung xac nhan so tien truoc khi tao QR.
 */
function resolveInvoiceTotal({ totalPayment, totalBeforeVat, vatAmount, wordsAmount, reader = 'AI' }) {
  const sum = totalBeforeVat !== null && vatAmount !== null ? totalBeforeVat + vatAmount : null;
  const same = (a, b) => a !== null && b !== null && Math.abs(a - b) <= 2;
  if (same(totalPayment, wordsAmount) || same(totalPayment, sum)) return { amount: totalPayment, status: 'ok', warning: null };
  if (same(sum, wordsAmount)) {
    const read = totalPayment === null ? 'không đọc được Tổng thanh toán' : `đọc Tổng thanh toán là ${vnd.format(totalPayment)}đ`;
    return {
      amount: wordsAmount,
      status: 'corrected',
      warning: `${reader} ${read}, nhưng Cộng tiền hàng + Tiền thuế và Số tiền bằng chữ đều là ${vnd.format(wordsAmount)}đ — đã dùng ${vnd.format(wordsAmount)}đ.`
    };
  }
  const amount = totalPayment ?? sum ?? wordsAmount;
  return {
    amount,
    status: 'unverified',
    warning: amount === null ? null
      : 'Không đối chiếu được Tổng thanh toán với Cộng tiền hàng + Tiền thuế / Số tiền bằng chữ — kiểm tra kỹ số tiền trên hóa đơn rồi mới bấm Tạo mã QR.'
  };
}

function createVatDraftService({ repository, masterData, vision = null, config = vatDraftConfig }) {
  async function loadMaster() {
    return masterData.get();
  }

  async function documentsInput(documents) {
    const docs = await repository.readDocumentLines(normalizeSelections(documents));
    return { docs, ...documentsToQueries(docs) };
  }

  /** Chuc nang 1 — Xu ly hoa don. */
  async function allocate({ source, documents, text } = {}) {
    let queries;
    let extraByOrder;
    let docs = [];
    const hasMeta = source === 'documents';
    if (hasMeta) {
      ({ docs, queries, extraByOrder } = await documentsInput(documents));
    } else if (source === 'paste') {
      const raw = pasteText(text);
      if (!pyStrip(raw)) throw badRequest('Hãy dán dữ liệu hóa đơn trước khi kiểm tra.');
      queries = rowsToQueries(parseInvoicePasteRows(raw));
      if (queries.length > MAX_LINES) throw badRequest(`Quá ${MAX_LINES} dòng mỗi lần xử lý.`);
    } else {
      throw badRequest('Nguồn dữ liệu không hợp lệ.');
    }
    if (!queries.length) throw badRequest('Chưa có dòng hóa đơn nào để kiểm tra.');

    const master = await loadMaster();
    const result = allocateInvoiceSources(queries, master.mappingRows, master.stockRows, config);
    const columns = buildUnifiedColumns(hasMeta);
    const display = buildUnifiedDisplayRows(result.lines, result.shortages, result.issues, { extraByOrder });

    let qr = null;
    if (result.lines.length) {
      const accountKeys = config.vietqr.accounts.map(a => a.key);
      const bySource = [...vietqr.computeSourceAmounts(result.lines).values()].map(amount => {
        const account = vietqr.getAccountForSource(amount.nguon, config);
        return {
          nguon: amount.nguon,
          soDong: amount.soDong,
          tongGiaBan: amount.tongGiaBan,
          tongGiaNhap: amount.tongGiaNhap,
          thieuDonGia: amount.thieuDonGia,
          defaultAccountKey: account && accountKeys.includes(account.key) ? account.key : accountKeys[0] || null,
          // int(round(x)) cua Python (banker's), khong am.
          defaultAmount: Math.max(pyRound(amount.tongGiaNhap), 0)
        };
      });
      const total = vietqr.computeTotalAmount(result.lines);
      qr = {
        transferContent: hasMeta ? docs.map(d => d.code).join(' ') : '',
        bySource,
        total: {
          soDong: total.soDong,
          tongGiaBan: total.tongGiaBan,
          thieuDonGia: total.thieuDonGia,
          defaultAccountKey: accountKeys[0] || null,
          defaultAmount: Math.max(pyRound(total.tongGiaBan), 0)
        }
      };
    }

    return {
      hasMeta,
      columns,
      rows: display.map(row => ({ values: columns.map(column => row[column] ?? null), reason: row['Ghi chú'] || '' })),
      metrics: {
        inputCount: queries.length,
        okProducts: new Set(result.lines.map(l => l.queryOrder)).size,
        shortageProducts: result.shortageProductCount,
        missingCount: result.issues.length
      },
      qr,
      documents: docs.map(d => ({ kind: d.kind, branch: d.branch, code: d.code })),
      masterData: masterDataMeta(master)
    };
  }

  /** Chuc nang 2 — URL anh QR (tai khoan cau hinh hoac nhap tay). */
  function qrUrl({ accountKey, manual, amount, addInfo } = {}) {
    let account;
    let accountLabel;
    if (manual) {
      const bankId = String(manual.bankId || '').trim();
      const accountNo = String(manual.accountNo || '').trim();
      const accountName = String(manual.accountName || '').trim().slice(0, 100);
      if (!vietqr.isValidManualField(bankId) || !vietqr.isValidManualField(accountNo)) {
        throw badRequest('Nhập đủ Mã ngân hàng và Số tài khoản (chỉ chữ và số) để tạo QR.');
      }
      account = { bankId, accountNo, accountName };
      accountLabel = `${bankId} - ${accountNo}${accountName ? ` (${accountName})` : ''}`;
    } else {
      account = config.vietqr.accounts.find(a => a.key === accountKey);
      if (!account) throw badRequest('Tài khoản nhận tiền không hợp lệ.');
      accountLabel = vietqr.formatAccountLabel(account);
    }
    const value = vietqr.parseAmountInput(String(amount ?? ''));
    const info = pyStrip(String(addInfo || '')).slice(0, 200);
    return {
      url: vietqr.buildVietqrImageUrl(account, { amount: value, addInfo: info, template: config.vietqr.template }),
      amount: value,
      accountLabel,
      addInfo: info
    };
  }

  /** Anh hoa don -> AI doc ten don vi ban + tong thanh toan -> tai khoan cong ty goi y. */
  async function parseInvoiceImage({ buffer, mimeType }) {
    if (!vision || !vision.configured) {
      const error = new Error('Chưa cấu hình AI đọc hóa đơn — vui lòng nhập số tiền và chọn tài khoản thủ công.');
      error.statusCode = 503;
      error.code = 'INVOICE_AI_NOT_CONFIGURED';
      throw error;
    }
    const raw = await vision.extractInvoice(buffer, mimeType);
    const text = value => (value === null || value === undefined ? '' : pyStrip(String(value).normalize('NFC')));
    const amount = value => parseInvoiceAmount(text(value));
    return invoiceResult({
      source: 'ai',
      sellerName: text(raw.sellerName),
      totalPayment: amount(raw.totalPayment),
      totalBeforeVat: amount(raw.totalBeforeVat),
      vatAmount: amount(raw.vatAmount),
      wordsText: text(raw.amountInWords),
      unrecognized: 'AI không nhận diện được hóa đơn trong ảnh — vui lòng nhập số tiền và chọn tài khoản thủ công.'
    });
  }

  /**
   * PDF co lop chu (hoa don dien tu luu tu trinh duyet): trinh duyet trich chu MOI trang bang pdf.js,
   * may chu doc bang regex nhu app cu — chinh xac, khong ton luot AI. Loi (PDF scan / khong dung mau)
   * thi trang chuyen sang doc anh bang AI.
   */
  function parsePdfText(text) {
    const parsed = parseInvoiceText(String(text || '').normalize('NFC').slice(0, 500000));
    if (parsed.error) return { source: 'pdf-text', error: parsed.error, matchedAccountKeys: [], warnings: [] };
    return invoiceResult({
      source: 'pdf-text',
      sellerName: parsed.sellerName,
      totalPayment: parsed.totalPayment,
      totalBeforeVat: parsed.totalBeforeVat,
      vatAmount: parsed.vatAmount,
      wordsText: parsed.amountInWords,
      unrecognized: 'Không nhận diện được hóa đơn trong PDF.'
    });
  }

  /** Ket qua chung cho anh (AI) va PDF (chu): doi chieu tong tien + tai khoan cong ty goi y. */
  function invoiceResult({ source, sellerName, totalPayment, totalBeforeVat, vatAmount, wordsText, unrecognized }) {
    const words = String(wordsText || '').slice(0, 300);
    const wordsAmount = parseVietnameseAmountWords(words);
    const total = resolveInvoiceTotal({ totalPayment, totalBeforeVat, vatAmount, wordsAmount, reader: source === 'ai' ? 'AI' : 'File PDF' });
    const parsed = {
      source,
      sellerName: String(sellerName || '').slice(0, 300),
      totalPayment: total.amount,
      amountStatus: total.status,
      // Cac nguon so tien de nguoi dung chon khi phai xac nhan (status khac 'ok').
      amountSources: {
        aiTotal: totalPayment,
        subtotalPlusVat: totalBeforeVat !== null && vatAmount !== null ? totalBeforeVat + vatAmount : null,
        words: wordsAmount,
        wordsText: words
      },
      totalBeforeVat,
      vatAmount,
      warnings: total.warning ? [total.warning] : [],
      error: null
    };
    if (!parsed.sellerName && parsed.totalPayment === null) parsed.error = unrecognized;
    return {
      ...parsed,
      matchedAccountKeys: parsed.error ? [] : vietqr.getAccountsForSeller(parsed.sellerName, config).map(a => a.key)
    };
  }

  function accountsMeta() {
    return {
      template: config.vietqr.template,
      commonBankCodes: vietqr.COMMON_BANK_CODES,
      // So TK in tren QR gui khach nen khong bi mat; tra rieng tung truong de trang hien ro
      // nguoi nhan / ngan hang / so TK va nhom Cong ty / Ca nhan trong o chon tai khoan.
      accounts: config.vietqr.accounts.map(a => ({
        key: a.key,
        label: vietqr.formatAccountLabel(a),
        bankId: a.bankId,
        accountNo: a.accountNo,
        accountName: a.accountName || '',
        group: /^CONG TY\b/i.test(a.accountName || '') ? 'company' : 'personal'
      }))
    };
  }

  return { allocate, qrUrl, parseInvoiceImage, parsePdfText, accountsMeta, masterDataMeta, parseDocumentCodes };
}

module.exports = { createVatDraftService, resolveInvoiceTotal, documentsToQueries, MAX_DOCUMENTS, MAX_LINES };
