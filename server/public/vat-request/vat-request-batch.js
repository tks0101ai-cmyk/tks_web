// Form tạo yêu cầu xuất VAT NHIỀU DÒNG (thay form Apps Script "Nhập ORDER VAT" cũ): mỗi dòng = 1 yêu cầu,
// gửi tất cả 1 lần qua POST /api/vat-requests/batch. Giữ cách làm quen của form cũ (bảng nhập, dán 6 cột từ
// Excel, tối đa 200 dòng, mã lần gửi chống trùng) và thêm: tra tên SP / tồn VAT / giá gần nhất theo từng dòng,
// dán vào ô nào cũng được, lỗi chỉ đúng dòng, tự lưu nháp, Enter thêm dòng, Ctrl+Enter gửi.
(function () {
  'use strict';

  const MAX_ROWS = 200;
  // Dán KHÔNG kèm dòng tiêu đề: hiểu cột theo thứ tự của form cũ, tính từ ô đang trỏ —
  // Khách hàng, Mã SP, Tên SP, Số lượng, Giá chưa VAT, Ghi chú.
  const PASTE_FIELDS = ['customerName', 'productCode', 'productName', 'quantity', 'unitPrice', 'saleNote'];
  const INPUT_FIELDS = ['customerName', 'productCode', 'quantity', 'unitPrice', 'fullVat', 'saleNote'];
  // Dán KÈM dòng tiêu đề (copy cả bảng, kể cả từ sheet ORDER VAT 1 cũ): ghép cột theo tên, thứ tự nào cũng được,
  // cột lạ (Thời gian, Email, Tên Sale, KT phản hồi…) bỏ qua. Full VAT KHÔNG lấy từ dữ liệu dán — sale tự chọn từng dòng.
  const HEADER_ALIASES = {
    customerName: ['khach hang', 'ten khach hang', 'ten khach', 'khach'],
    productCode: ['ma sp trim', 'ma sp', 'ma hang', 'ma san pham', 'ma kiot'],
    productName: ['ten sp', 'ten hang', 'ten san pham'],
    quantity: ['so luong', 'slg', 'sl'],
    unitPrice: ['gia chua vat', 'gia ban', 'don gia', 'gia'],
    saleNote: ['ghi chu', 'note']
  };

  function headerKey(text) {
    return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase()
      .replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function headerField(cell) {
    const key = headerKey(cell);
    if (!key) return null;
    for (const [name, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.some(alias => key === alias || key.startsWith(alias + ' '))) return name;
    }
    return null;
  }

  /** '12.500' (kiểu VN) · '12,500' · '12500 ₫' -> 12500; trống / sai -> NaN. */
  function parseAmount(value) {
    let text = String(value == null ? '' : value).replace(/[\s₫đ]/gi, '');
    if (!text) return NaN;
    if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(text)) text = text.replace(/\./g, '').replace(',', '.');
    else text = text.replace(/,/g, '');
    return /^\d+(\.\d+)?$/.test(text) ? Number(text) : NaN;
  }

  /** Clipboard Excel -> ma trận ô; null nếu không phải dữ liệu bảng (để trình duyệt dán bình thường). */
  function parseClipboard(text) {
    if (!text || (!text.includes('\t') && !/[\r\n]/.test(text.trim()))) return null;
    return text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n').filter(line => line.trim()).map(line => line.split('\t').map(cell => cell.trim()));
  }

  /**
   * Ma trận dán -> { rows: [{ tên trường: giá trị }], header }. Dòng đầu có ≥ 2 tiêu đề quen (trong đó có Mã SP)
   * thì ghép theo tên cột và bỏ dòng đó; không thì ghép theo thứ tự PASTE_FIELDS bắt đầu từ `startField`.
   */
  function mapPastedMatrix(matrix, startField = 'customerName') {
    if (!matrix || !matrix.length) return { rows: [], header: false };
    const named = matrix[0].map(headerField);
    const header = named.includes('productCode') && new Set(named.filter(Boolean)).size >= 2;
    const start = Math.max(0, PASTE_FIELDS.indexOf(startField));
    const columnAt = index => (header ? (named.indexOf(named[index]) === index ? named[index] : null) : PASTE_FIELDS[start + index] || null);
    const rows = (header ? matrix.slice(1) : matrix).map(cells => {
      const values = {};
      cells.forEach((cell, index) => {
        const name = columnAt(index);
        if (!name || name === 'productName') return; // tên SP lấy theo mã
        const amount = parseAmount(cell);
        values[name] = (name === 'quantity' || name === 'unitPrice') && Number.isFinite(amount) ? String(amount) : cell;
      });
      return values;
    }).filter(values => Object.values(values).some(value => String(value).trim()));
    return { rows, header };
  }

  function createBatchForm(deps) {
    const { api, escapeHtml, fmtNumber, debounce, showDialog, closeDialog, onSubmitted } = deps;
    const $ = id => document.getElementById(id);
    const dialog = $('vrBatchDialog');
    const body = $('vrBatchRows');
    const info = new Map(); // product_key -> kết quả /lookup
    const draftKey = 'vr-batch-draft:' + (deps.userId || 'anon');
    let saving = false;
    let lastSubmission = null; // { key, id } — gửi lại đúng dữ liệu cũ thì dùng lại mã lần gửi
    let initialized = false;

    const rowsEl = () => [...body.querySelectorAll('tr[data-row]')];
    const field = (tr, name) => tr.querySelector(`[data-field="${name}"]`);
    const keyOf = code => String(code || '').trim().toLowerCase();

    function rowValues(tr) {
      return {
        customerName: field(tr, 'customerName').value.trim(),
        productCode: field(tr, 'productCode').value.trim(),
        quantity: field(tr, 'quantity').value.trim(),
        unitPrice: field(tr, 'unitPrice').value.trim(),
        // null = chưa chọn (bắt buộc chọn trước khi gửi)
        fullVat: field(tr, 'fullVat').value === '' ? null : field(tr, 'fullVat').value === 'true',
        saleNote: field(tr, 'saleNote').value.trim()
      };
    }
    // Dòng chỉ có khách (tự chép từ dòng trên) chưa tính là dòng hàng.
    const isMeaningful = v => !!(v.productCode || v.quantity || v.unitPrice || v.saleNote);

    function rowHtml() {
      return `<tr data-row>
        <td class="vr-b-index" data-label="#"></td>
        <td data-label="Khách hàng"><input data-field="customerName" list="vrBatchCustomerList" maxlength="200" autocomplete="off" placeholder="Tên khách"></td>
        <td data-label="Mã SP"><input data-field="productCode" list="vrBatchProductList" maxlength="60" autocomplete="off" placeholder="Mã hoặc tên SP"></td>
        <td class="vr-b-product" data-label="Sản phẩm" data-cell="product"><span class="vr-muted">—</span></td>
        <td data-label="Số lượng"><input data-field="quantity" class="num" inputmode="numeric" autocomplete="off"></td>
        <td data-label="Giá chưa VAT"><input data-field="unitPrice" class="num" inputmode="decimal" autocomplete="off"><div class="vr-b-hint" data-cell="price"></div></td>
        <td data-label="Full VAT"><select data-field="fullVat" class="vr-b-select"><option value="">— Chọn —</option><option value="true">Full VAT</option><option value="false">Chưa VAT</option></select></td>
        <td data-label="Ghi chú"><input data-field="saleNote" maxlength="1000" autocomplete="off" placeholder="Mã VAT nếu có"></td>
        <td class="num vr-b-total" data-label="Thành tiền" data-cell="total">—</td>
        <td class="vr-b-center"><button type="button" class="vr-b-remove" data-remove aria-label="Xóa dòng" title="Xóa dòng">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg></button></td>
      </tr>`;
    }

    function setRow(tr, values) {
      for (const name of INPUT_FIELDS) {
        if (!(name in values)) continue;
        const input = field(tr, name);
        if (name === 'fullVat') input.value = values.fullVat === true ? 'true' : values.fullVat === false ? 'false' : '';
        else input.value = values[name] == null ? '' : String(values[name]);
      }
    }

    function addRow(values = {}, { focus = false } = {}) {
      const rows = rowsEl();
      if (rows.length >= MAX_ROWS) { showError(`Mỗi lần gửi tối đa ${MAX_ROWS} dòng.`); return null; }
      body.insertAdjacentHTML('beforeend', rowHtml());
      const tr = body.lastElementChild;
      const previous = rows[rows.length - 1];
      // Dòng mới dùng lại khách của dòng trên — đơn 1 khách nhiều mã chỉ gõ tên 1 lần.
      setRow(tr, { customerName: previous ? field(previous, 'customerName').value : '', ...values });
      refreshRow(tr);
      if (focus) field(tr, previous && field(previous, 'customerName').value ? 'productCode' : 'customerName').focus();
      return tr;
    }

    // ---------- Hiển thị theo dòng ----------
    function refreshRow(tr) {
      const v = rowValues(tr);
      const qty = parseAmount(v.quantity);
      const price = parseAmount(v.unitPrice);
      tr.querySelector('[data-cell="total"]').textContent = Number.isFinite(qty) && Number.isFinite(price) ? fmtNumber(qty * price) : '—';
      const product = tr.querySelector('[data-cell="product"]');
      const hint = tr.querySelector('[data-cell="price"]');
      const key = keyOf(v.productCode);
      const found = key ? info.get(key) : null;
      field(tr, 'productCode').removeAttribute('data-unknown');
      if (!key) { product.innerHTML = '<span class="vr-muted">—</span>'; hint.innerHTML = ''; return; }
      if (!found) { product.innerHTML = '<span class="vr-muted">Đang tra mã…</span>'; hint.innerHTML = ''; return; }
      if (!found.found) {
        product.innerHTML = '<span class="vr-error-text">Không có mã này</span>';
        field(tr, 'productCode').setAttribute('data-unknown', 'true');
        hint.innerHTML = '';
        return;
      }
      // Tồn / hàng về / chờ khai chỉ có khi là KT (server không gửi cho sale).
      const meta = found.pendingInsertQty === undefined ? '' : [
        `Tồn VAT <b>${found.vatStock ? fmtNumber(found.vatStock.total) : '—'}</b>`,
        found.incomingContainer ? `Cont <b>${escapeHtml(found.incomingContainer)}</b>${found.containerStatus || found.containerEta ? ' · ' + escapeHtml([found.containerStatus, found.containerEta].filter(Boolean).join(' ')) : ''}` : '',
        found.pendingInsertQty ? `Chờ khai <b>${fmtNumber(found.pendingInsertQty)}</b>` : ''
      ].filter(Boolean).join(' · ');
      product.innerHTML = `<span class="vr-b-name" title="${escapeHtml(found.productName)}">${escapeHtml(found.productName)}</span><span class="vr-b-meta">${meta}</span>`;
      const recent = found.latestOrder;
      hint.innerHTML = recent && recent.price > 0 && parseAmount(v.unitPrice) !== recent.price
        ? `<button type="button" data-use-price="${recent.price}" title="Giá yêu cầu VAT gần nhất${recent.customerName ? ' · ' + escapeHtml(recent.customerName) : ''}">Gần nhất ${fmtNumber(recent.price)}</button>`
        : '';
    }

    function renumber() {
      rowsEl().forEach((tr, index) => {
        tr.querySelector('.vr-b-index').textContent = index + 1;
        tr.querySelectorAll('input').forEach(input => {
          const label = { customerName: 'Khách hàng', productCode: 'Mã SP', quantity: 'Số lượng', unitPrice: 'Giá chưa VAT', fullVat: 'Full VAT', saleNote: 'Ghi chú' }[input.dataset.field];
          input.setAttribute('aria-label', `${label} dòng ${index + 1}`);
        });
      });
      updateSummary();
    }

    function updateSummary() {
      const items = rowsEl().map(rowValues).filter(isMeaningful);
      const total = items.reduce((sum, v) => {
        const amount = parseAmount(v.quantity) * parseAmount(v.unitPrice);
        return Number.isFinite(amount) ? sum + amount : sum;
      }, 0);
      const unset = items.filter(v => v.fullVat === null).length;
      $('vrBatchSummary').innerHTML = `<b>${items.length}</b> dòng hàng${total ? ` · Tổng <b>${fmtNumber(total)} ₫</b>` : ''}` +
        (unset ? ` · <span class="vr-b-warn">${unset} dòng chưa chọn Full VAT</span>` : '');
      if (!saving) $('vrBatchSubmitLabel').textContent = items.length > 1 ? `Gửi ${items.length} yêu cầu` : 'Gửi yêu cầu';
      $('vrBatchSubmit').disabled = saving || !items.length;
    }

    // ---------- Tra mã (1 lần cho cả bảng) ----------
    const lookupLater = debounce(lookupMissing, 350);
    let lookupSeq = 0;
    async function lookupMissing() {
      const codes = [...new Set(rowsEl().map(tr => field(tr, 'productCode').value.trim()).filter(code => code && !info.has(keyOf(code))))];
      if (!codes.length) return;
      const seq = ++lookupSeq;
      try {
        const data = await api('/lookup', { method: 'POST', body: { codes } });
        for (const code of codes) info.set(keyOf(code), (data.results || {})[keyOf(code)] || { found: false });
      } catch (error) {
        if (seq === lookupSeq) showError('Chưa tra được mã SP: ' + error.message);
        return;
      }
      rowsEl().forEach(refreshRow);
    }

    // ---------- Gợi ý (dùng chung 2 datalist cho mọi dòng) ----------
    const suggestProducts = debounce(async (input, query) => {
      if (!query.trim()) return;
      try {
        const data = await api('/product-suggest?q=' + encodeURIComponent(query.trim()));
        if (input.value !== query) return;
        $('vrBatchProductList').innerHTML = (data.results || []).map(p => `<option value="${escapeHtml(p.code)}">${escapeHtml(p.name)}</option>`).join('');
      } catch (error) { /* gợi ý không bắt buộc */ }
    }, 250);
    const customerCodes = new Map();
    const suggestCustomers = debounce(async (input, query) => {
      if (query.trim().length < 2) return;
      try {
        const data = await api('/customer-suggest?q=' + encodeURIComponent(query.trim()) + '&limit=10');
        if (input.value !== query) return;
        $('vrBatchCustomerList').innerHTML = (data.results || []).map(c => {
          if (c.code) customerCodes.set(c.name, c.code);
          const source = c.source === 'order-vat' ? 'Đã dùng trong VAT' : 'KiotViet';
          return `<option value="${escapeHtml(c.name)}" label="${escapeHtml([c.code, source].filter(Boolean).join(' · '))}"></option>`;
        }).join('');
      } catch (error) { /* gợi ý không bắt buộc */ }
    }, 300);

    // ---------- Dán từ Excel ----------
    /**
     * Đổ dữ liệu dán vào bảng. Bắt đầu ở dòng đang trỏ (dán vào ô), không thì ở dòng trống đầu tiên,
     * thiếu dòng thì thêm. Full VAT để trống — sale tự chọn từng dòng.
     */
    function applyPaste(matrix, { startField = 'customerName', startRow = null } = {}) {
      const { rows, header } = mapPastedMatrix(matrix, startField);
      if (!rows.length) { showError('Không đọc được dòng hàng nào trong dữ liệu vừa dán.'); return 0; }
      showError('');
      let tr = startRow || rowsEl().find(row => !isMeaningful(rowValues(row))) || null;
      let pasted = 0;
      for (const values of rows) {
        if (!tr) tr = addRow({});
        if (!tr) break;
        setRow(tr, values);
        clearRowErrors(tr);
        refreshRow(tr);
        pasted += 1;
        tr = tr.nextElementSibling;
      }
      renumber();
      lookupLater();
      saveDraftLater();
      const pending = rowsEl().filter(row => isMeaningful(rowValues(row)) && rowValues(row).fullVat === null);
      showNotice(`Đã dán ${pasted} dòng${header ? ' (khớp cột theo dòng tiêu đề)' : ''}.` +
        (pending.length ? ` Chọn Full VAT / Chưa VAT cho ${pending.length} dòng trước khi gửi.` : ''));
      if (pending.length) field(pending[0], 'fullVat').focus();
      return pasted;
    }

    function clipboardMatrix(event) {
      return parseClipboard(event.clipboardData && event.clipboardData.getData('text'));
    }

    // Dán vào 1 ô của bảng: cột tính từ ô đó (khi không có tiêu đề).
    function handlePaste(event) {
      const input = event.target;
      if (!input.matches || !input.matches('input[data-field]') || PASTE_FIELDS.indexOf(input.dataset.field) < 0) return;
      const matrix = clipboardMatrix(event);
      if (!matrix) return; // 1 giá trị đơn: để trình duyệt dán bình thường
      event.preventDefault();
      applyPaste(matrix, { startField: input.dataset.field, startRow: input.closest('tr') });
    }

    function togglePastePanel(open) {
      const panel = $('vrBatchPastePanel');
      panel.hidden = !open;
      $('vrBatchPasteToggle').setAttribute('aria-expanded', String(open));
      if (open) $('vrBatchPasteArea').focus();
    }

    function pasteFromArea(text) {
      const matrix = parseClipboard(text) || (String(text || '').trim() ? [String(text).trim().split('\t')] : null);
      if (!matrix) return;
      $('vrBatchPasteArea').value = '';
      if (applyPaste(matrix)) togglePastePanel(false);
    }

    // ---------- Lỗi ----------
    function showError(message) { $('vrBatchError').textContent = message || ''; }
    function showNotice(message) {
      const notice = $('vrBatchNotice');
      notice.textContent = message || '';
      notice.hidden = !message;
    }
    function clearRowErrors(tr) {
      tr.classList.remove('has-error');
      tr.querySelectorAll('[aria-invalid]').forEach(input => { input.removeAttribute('aria-invalid'); input.removeAttribute('title'); });
    }
    function markErrors(entries) {
      rowsEl().forEach(clearRowErrors);
      for (const entry of entries) {
        const tr = entry.tr;
        if (!tr) continue;
        tr.classList.add('has-error');
        const input = entry.field && field(tr, entry.field);
        if (input) { input.setAttribute('aria-invalid', 'true'); input.title = entry.message; }
      }
      const rows = new Set(entries.map(e => e.tr)).size;
      showError(entries.length ? `${rows} dòng chưa hợp lệ, chưa gửi dòng nào. ${entries.slice(0, 3).map(e => e.message).join(' · ')}${entries.length > 3 ? ' …' : ''}` : '');
      const first = entries.find(e => e.tr);
      if (first) (first.field && field(first.tr, first.field) || first.tr.querySelector('input')).focus();
    }

    function validate(pairs) {
      const errors = [];
      pairs.forEach(({ tr, values }) => {
        const n = rowsEl().indexOf(tr) + 1;
        const push = (name, message) => errors.push({ tr, field: name, message: `Dòng ${n}: ${message}` });
        if (!values.customerName) push('customerName', 'thiếu khách hàng.');
        if (!values.productCode) push('productCode', 'thiếu mã SP.');
        else if (info.get(keyOf(values.productCode)) && !info.get(keyOf(values.productCode)).found) push('productCode', `không có mã SP "${values.productCode}".`);
        const qty = parseAmount(values.quantity);
        if (!Number.isInteger(qty) || qty <= 0) push('quantity', 'số lượng phải là số nguyên lớn hơn 0.');
        const price = parseAmount(values.unitPrice);
        if (!Number.isFinite(price) || price <= 0) push('unitPrice', 'giá chưa VAT phải lớn hơn 0.');
        if (values.fullVat === null) push('fullVat', 'chưa chọn Full VAT / Chưa VAT.');
      });
      return errors;
    }

    // ---------- Gửi ----------
    function newSubmissionId() {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
      return 'SUB-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    }

    function setSaving(on) {
      saving = on;
      const button = $('vrBatchSubmit');
      button.classList.toggle('is-loading', on);
      button.setAttribute('aria-busy', String(on));
      ['vrBatchAdd', 'vrBatchReset'].forEach(id => { $(id).disabled = on; });
      if (on) $('vrBatchSubmitLabel').textContent = 'Đang gửi…';
      updateSummary();
    }

    async function submit() {
      if (saving) return;
      showNotice('');
      const pairs = rowsEl().map(tr => ({ tr, values: rowValues(tr) })).filter(p => isMeaningful(p.values));
      if (!pairs.length) { showError('Chưa có dòng hàng nào.'); return; }
      const errors = validate(pairs);
      if (errors.length) { markErrors(errors); return; }
      markErrors([]);
      const items = pairs.map(({ values }) => ({
        customerName: values.customerName,
        customerCode: customerCodes.get(values.customerName) || null,
        productCode: values.productCode,
        quantity: parseAmount(values.quantity),
        unitPrice: parseAmount(values.unitPrice),
        fullVat: values.fullVat,
        saleNote: values.saleNote
      }));
      const key = JSON.stringify(items);
      if (!lastSubmission || lastSubmission.key !== key) lastSubmission = { key, id: newSubmissionId() };
      setSaving(true);
      try {
        const result = await api('/batch', { method: 'POST', body: { submissionId: lastSubmission.id, items } });
        lastSubmission = null;
        clearDraft();
        resetRows();
        setSaving(false);
        closeDialog(dialog);
        await onSubmitted(result);
      } catch (error) {
        setSaving(false);
        if (error.status === 400 && Array.isArray(error.data && error.data.errors)) {
          markErrors(error.data.errors.map(e => ({ tr: pairs[e.row - 1] && pairs[e.row - 1].tr, field: e.field, message: e.message.replace(/^Dòng \d+/, `Dòng ${rowsEl().indexOf(pairs[e.row - 1] && pairs[e.row - 1].tr) + 1}`) })));
        } else {
          showError((error.message || 'Gửi không thành công.') + ' Dữ liệu vẫn còn trên màn hình, bấm Gửi để thử lại.');
        }
      }
    }

    // ---------- Nháp (chỉ trình duyệt này) ----------
    const saveDraftLater = debounce(saveDraft, 500);
    function saveDraft() {
      try {
        const rows = rowsEl().map(rowValues).filter(isMeaningful);
        if (rows.length) localStorage.setItem(draftKey, JSON.stringify({ savedAt: Date.now(), rows }));
        else localStorage.removeItem(draftKey);
      } catch (error) { /* bộ nhớ trình duyệt là tùy chọn */ }
    }
    function readDraft() {
      try {
        const draft = JSON.parse(localStorage.getItem(draftKey) || 'null');
        return draft && Array.isArray(draft.rows) ? draft.rows.slice(0, MAX_ROWS) : [];
      } catch (error) { return []; }
    }
    function clearDraft() { try { localStorage.removeItem(draftKey); } catch (error) { /* tùy chọn */ } }

    function resetRows() {
      body.innerHTML = '';
      addRow({ customerName: '' });
      renumber();
      showError('');
    }

    function reset() {
      if (rowsEl().map(rowValues).some(isMeaningful) && !window.confirm('Xóa toàn bộ dòng đang nhập?')) return;
      clearDraft();
      lastSubmission = null;
      showNotice('');
      resetRows();
      field(rowsEl()[0], 'customerName').focus();
    }

    function bind() {
      body.addEventListener('input', event => {
        const input = event.target;
        const tr = input.closest('tr[data-row]');
        if (!tr) return;
        input.removeAttribute('aria-invalid');
        if (!tr.querySelector('[aria-invalid]')) tr.classList.remove('has-error');
        if (input.dataset.field === 'productCode') { suggestProducts(input, input.value); lookupLater(); }
        if (input.dataset.field === 'customerName') suggestCustomers(input, input.value);
        refreshRow(tr);
        updateSummary();
        saveDraftLater();
      });
      body.addEventListener('change', event => {
        if (event.target.dataset.field === 'productCode') lookupMissing();
        if (event.target.dataset.field === 'fullVat') saveDraftLater();
      });
      body.addEventListener('paste', handlePaste);
      body.addEventListener('click', event => {
        const remove = event.target.closest('[data-remove]');
        if (remove) {
          const tr = remove.closest('tr');
          const next = tr.nextElementSibling || tr.previousElementSibling;
          tr.remove();
          if (!rowsEl().length) addRow({ customerName: '' });
          renumber();
          saveDraftLater();
          const target = next && next.isConnected ? next : rowsEl()[0];
          field(target, 'productCode').focus();
          return;
        }
        const use = event.target.closest('[data-use-price]');
        if (use) {
          const tr = use.closest('tr');
          field(tr, 'unitPrice').value = use.dataset.usePrice;
          field(tr, 'unitPrice').removeAttribute('aria-invalid');
          refreshRow(tr);
          updateSummary();
          saveDraftLater();
          field(tr, 'quantity').value ? field(tr, 'saleNote').focus() : field(tr, 'quantity').focus();
        }
      });
      body.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || event.isComposing || !event.target.matches('input')) return;
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) { submit(); return; }
        const tr = event.target.closest('tr');
        if (tr === body.lastElementChild) { addRow({}, { focus: true }); renumber(); }
        else field(tr.nextElementSibling, event.target.dataset.field === 'fullVat' ? 'saleNote' : event.target.dataset.field).focus();
      });
      $('vrBatchAdd').addEventListener('click', () => { addRow({}, { focus: true }); renumber(); });
      // Ô "Dán từ Excel": nhận cả Ctrl+V lẫn dán bằng chuột phải / gõ tay rồi rời ô.
      $('vrBatchPasteToggle').addEventListener('click', () => togglePastePanel($('vrBatchPastePanel').hidden));
      $('vrBatchPasteArea').addEventListener('paste', event => {
        const text = event.clipboardData && event.clipboardData.getData('text');
        if (!text) return; // trình duyệt không cho đọc clipboard: để dán vào ô rồi xử lý ở 'input'
        event.preventDefault();
        pasteFromArea(text);
      });
      $('vrBatchPasteArea').addEventListener('input', event => {
        if (/[\t\n]/.test(event.target.value)) pasteFromArea(event.target.value);
      });
      // Ctrl+V ở chỗ khác trong form (nút, vùng trống) cũng nhận như dán vào dòng trống đầu tiên.
      dialog.addEventListener('paste', event => {
        if (event.defaultPrevented || event.target.closest('input, textarea, select')) return;
        const matrix = clipboardMatrix(event);
        if (!matrix) return;
        event.preventDefault();
        applyPaste(matrix);
      });
      $('vrBatchReset').addEventListener('click', reset);
      $('vrBatchCancel').addEventListener('click', () => closeDialog(dialog));
      $('vrBatchClose').addEventListener('click', () => closeDialog(dialog));
      $('vrBatchForm').addEventListener('submit', event => { event.preventDefault(); submit(); });
    }

    function open() {
      if (!initialized) {
        initialized = true;
        bind();
        const draft = readDraft();
        if (draft.length) {
          draft.forEach((values, index) => addRow(index === 0 ? values : { customerName: '', ...values }));
          showNotice(`Đã khôi phục ${draft.length} dòng chưa gửi từ lần trước. Bấm "Làm mới" nếu không cần.`);
          lookupMissing();
        } else {
          addRow({ customerName: '' });
        }
        renumber();
      }
      showDialog(dialog);
      const rows = rowsEl();
      // Form trống: mở sẵn ô "Dán từ Excel" — cách nhanh nhất khi sale đã có danh sách.
      if (!rows.some(tr => isMeaningful(rowValues(tr)))) { togglePastePanel(true); return; }
      const empty = rows.find(tr => !isMeaningful(rowValues(tr))) || rows[rows.length - 1];
      field(empty, field(empty, 'customerName').value ? 'productCode' : 'customerName').focus();
    }

    // Dong "Order VAT" chuyen sang tu hop chi tiet hoa don / don hang (shared/vat-handoff.js, 17/11/2026): mo form (nhap
    // cu van duoc khoi phuc nhu thuong) roi them SAU cac dong dang co — dong trong san co duoc dung truoc. Khong tu gui.
    function prefill(rows, source) {
      open();
      togglePastePanel(false);
      const blanks = rowsEl().filter(tr => !isMeaningful(rowValues(tr)));
      let added = 0;
      for (const values of rows) {
        const blank = blanks.shift();
        const tr = blank ? body.appendChild(blank) : addRow({});
        if (!tr) break;
        setRow(tr, { ...values, fullVat: null });
        refreshRow(tr);
        added += 1;
      }
      renumber();
      saveDraft();
      lookupMissing();
      const skipped = rows.length - added;
      showError('');
      showNotice(`Đã thêm ${added} dòng từ ${source}. Kiểm tra, chọn Full VAT rồi bấm Gửi.` +
        (skipped ? ` Còn ${skipped} dòng không thêm được vì mỗi lần gửi tối đa ${MAX_ROWS} dòng.` : ''));
      return added;
    }

    return { open, submit, prefill, addRow: values => { const tr = addRow(values); renumber(); return tr; } };
  }

  window.TKSVatRequestBatch = { createBatchForm, parseAmount, parseClipboard, mapPastedMatrix, MAX_ROWS };
})();
