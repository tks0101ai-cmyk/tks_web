/* Tab Hóa đơn — mục 2 "Bảng giá duyệt" (API /api/invoice-approved-prices).
   Giá Quản lý đã duyệt riêng cho (cơ sở, khách, mã hàng): khi Kiểm tra giá bán tính sai giá, giá duyệt THAY giá min của hóa đơn
   có ngày bán ≥ Ngày duyệt. Xem theo reports.invoices.approvedPrice (mặc định chỉ Quản lý, ẩn với người khác); Tạo / Sửa / Xóa theo reports.invoices.approvedPrice.manage.
   Lọc (từ khóa khách / sản phẩm / người duyệt, Người duyệt, Ngày duyệt Từ–Đến), sắp xếp mọi cột và phân trang ở máy chủ; Xuất Excel theo bộ lọc + thứ tự sort.
   Khách / mã SP chỉ chọn được từ gợi ý KiotViet của cơ sở (lưu theo id nên Kiot đổi tên thì bảng tự cập nhật). */
(function () {
  'use strict';

  const API = '/api/invoice-approved-prices';
  const FEATURE_VIEW = 'reports.invoices.approvedPrice';
  const FEATURE_MANAGE = 'reports.invoices.approvedPrice.manage';
  const APPROVERS = ['Anh Quân', 'Anh Duy', 'Anh Duy Khánh'];
  const BRANCHES = [['hanoi', 'Hà Nội'], ['saigon', 'Sài Gòn']];
  const COLUMN_COUNT = 9;

  const state = {
    data: null, error: '', loading: false, seq: 0, loadedAt: 0, initialized: false,
    filters: { approver: '', from: '', to: '', q: '' }, sort: '', dir: 'asc', page: 1, pageSize: 50
  };

  const $ = id => document.getElementById(id);
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const can = key => !!(window.TKSNav && typeof window.TKSNav.can === 'function' && window.TKSNav.can(key));
  const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
  const isBlank = v => v === null || v === undefined || v === '';
  const fmtPrice = v => (isBlank(v) || !Number.isFinite(Number(v)) ? '—' : NUMBER.format(Number(v)));
  // Nhãn giá cho hộp xác nhận xóa: chỉ in giá đã nhập ("không VAT 23,000 · có VAT 25,000").
  const pricesLabel = r => [!isBlank(r.priceNoVat) ? 'không VAT ' + fmtPrice(r.priceNoVat) : '', !isBlank(r.priceWithVat) ? 'có VAT ' + fmtPrice(r.priceWithVat) : ''].filter(Boolean).join(' · ') || '—';
  const fmtDay = v => { const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '/' + m[2] + '/' + m[1] : (v ? String(v) : '—'); };
  const todayVn = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const toast = (message, type) => { if (typeof window.showToast === 'function') window.showToast(message, type); };
  const canManage = () => can(FEATURE_MANAGE);

  async function readJson(res) {
    if (res.status === 401) {
      window.location.href = '/login/?next=' + encodeURIComponent(location.pathname + location.search + location.hash);
      throw new Error('Phiên đăng nhập đã hết hạn.');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error((body && body.error) || 'HTTP ' + res.status), { status: res.status, body: body });
    return body;
  }

  // ---------- bảng ----------
  function queryString(extra) {
    const params = new URLSearchParams();
    Object.keys(state.filters).forEach(k => { if (state.filters[k]) params.set(k, state.filters[k]); });
    if (state.sort) { params.set('sort', state.sort); params.set('dir', state.dir); }
    Object.keys(extra || {}).forEach(k => params.set(k, extra[k]));
    return params.toString();
  }

  function noteRow(message) {
    return '<tr><td colspan="' + COLUMN_COUNT + '" class="table-note">' + escape(message) + '</td></tr>';
  }

  function rowHtml(r) {
    const manage = canManage();
    const customer = r.customerMissing
      ? '<span class="approved-price-missing">(khách không còn trên KiotViet)</span>'
      : escape(r.customerName) + (r.customerCode ? ' <span class="muted">· ' + escape(r.customerCode) + '</span>' : '');
    const actions = manage
      ? '<div class="approved-price-actions">' +
        '<button type="button" class="btn-secondary price-audit-btn" data-action="edit">Sửa</button>' +
        '<button type="button" class="btn-secondary price-audit-btn approved-price-btn-danger" data-action="delete">Xóa</button></div>'
      : '<span class="muted">—</span>';
    return '<tr data-id="' + escape(r.id) + '">' +
      '<td class="name-cell price-audit-wrap">' + customer + '</td>' +
      '<td>' + escape(r.branchLabel) + '</td>' +
      '<td class="mono">' + escape(r.productCode || '—') + '</td>' +
      '<td class="name-cell price-audit-wrap">' + escape(r.productName || '—') + '</td>' +
      '<td class="mono col-num' + (isBlank(r.priceNoVat) ? ' muted' : '') + '">' + escape(fmtPrice(r.priceNoVat)) + '</td>' +
      '<td class="mono col-num' + (isBlank(r.priceWithVat) ? ' muted' : '') + '">' + escape(fmtPrice(r.priceWithVat)) + '</td>' +
      '<td>' + escape(r.approver) + '</td>' +
      '<td class="mono">' + escape(fmtDay(r.approvedOn)) + '</td>' +
      '<td>' + actions + '</td></tr>';
  }

  function totalPages() {
    const d = state.data;
    return d && d.totalRows ? Math.max(1, Math.ceil(Number(d.totalRows) / state.pageSize)) : 1;
  }

  // Chỉ số theo mục (cùng bộ lọc với bảng, tính ở máy chủ trên toàn tập đã lọc).
  function renderKpis() {
    const box = $('approvedPriceKpis');
    const k = state.data && state.data.kpis;
    if (!k) { box.innerHTML = ''; return; }
    const card = (label, value, accent, sub) => '<div class="kpi-card col-3 accent-' + accent + '"><div class="eyebrow">' + escape(label) +
      '</div><div class="value">' + escape(value) + '</div>' + (sub ? '<div class="sub">' + escape(sub) + '</div>' : '') + '</div>';
    box.innerHTML =
      card('Bản ghi giá duyệt', NUMBER.format(Number(k.records) || 0), 'blue', 'theo bộ lọc hiện tại') +
      card('Khách có giá duyệt', NUMBER.format(Number(k.customers) || 0), 'green', 'tính theo từng cơ sở') +
      card('Mã SP có giá duyệt', NUMBER.format(Number(k.products) || 0), 'amber', 'tính theo từng cơ sở') +
      card('Duyệt gần nhất', k.latestApprovedOn ? fmtDay(k.latestApprovedOn) : '—', 'blue');
  }

  function render() {
    const d = state.data;
    renderKpis();
    const body = $('approvedPriceRows');
    if (state.error) body.innerHTML = noteRow(state.error);
    else if (!d) body.innerHTML = noteRow('Đang tải...');
    else body.innerHTML = d.rows.length ? d.rows.map(rowHtml).join('')
      : noteRow(state.filters.approver || state.filters.from || state.filters.to || state.filters.q ? 'Không có bản ghi nào khớp bộ lọc.' : 'Chưa có bản ghi giá duyệt nào.');
    const total = d ? Number(d.totalRows) || 0 : 0;
    $('tagApprovedPrice').textContent = d ? NUMBER.format(total) + ' bản ghi' : '—';
    $('approvedPricePagination').hidden = !d || total === 0;
    $('approvedPricePageLabel').textContent = 'Trang ' + state.page + '/' + totalPages();
    $('approvedPriceFirstPage').disabled = $('approvedPricePrevPage').disabled = state.page <= 1;
    $('approvedPriceNextPage').disabled = $('approvedPriceLastPage').disabled = state.page >= totalPages();
    $('approvedPriceCreateButton').hidden = !canManage();
    $('approvedPriceImportButton').hidden = !canManage();
    $('approvedPriceExportButton').hidden = !can('reports.export');
    ['approver', 'from', 'to', 'q'].forEach(name => {
      const el = $(name === 'approver' ? 'approvedPriceApproverFilter' : name === 'from' ? 'approvedPriceFrom' : name === 'to' ? 'approvedPriceTo' : 'approvedPriceSearch');
      if (el.value !== state.filters[name]) el.value = state.filters[name];
    });
  }

  async function fetchPage() {
    const seq = ++state.seq;
    state.loading = true;
    try {
      const data = await readJson(await fetch(API + '?' + queryString({ page: state.page, pageSize: state.pageSize }), { credentials: 'same-origin' }));
      if (seq !== state.seq) return;
      state.data = data;
      state.error = '';
      state.loadedAt = Date.now();
      // Trang hiện tại vượt quá số trang mới (vd vừa xóa bản ghi cuối của trang) → về trang cuối.
      if (!data.rows.length && state.page > 1 && Number(data.totalRows) > 0) { state.page = totalPages(); return fetchPage(); }
    } catch (err) {
      if (seq !== state.seq) return;
      console.error('Không tải được bảng Giá duyệt:', err);
      state.error = err.status === 400 ? 'Bộ lọc không hợp lệ: ' + err.message
        : (err.status === 503 && err.body && err.body.code === 'NOT_MIGRATED') ? err.message
          : (err.message && err.status < 500 ? err.message : 'Không tải được bảng Giá duyệt.');
    } finally {
      if (seq === state.seq) { state.loading = false; render(); }
    }
  }

  // ---------- sắp xếp theo cột (ở máy chủ) ----------
  const SORT_GLYPH = { none: '▲▼', ascending: '▼', descending: '▲' };
  function paintSortHeaders() {
    document.querySelectorAll('#approvedPriceHead th.sortable').forEach(th => {
      const active = state.sort === th.dataset.sort;
      const mode = active ? (state.dir === 'desc' ? 'descending' : 'ascending') : 'none';
      th.setAttribute('aria-sort', mode);
      th.classList.toggle('sort-active', active);
      const ind = th.querySelector('.sort-indicator');
      if (ind && ind.textContent !== SORT_GLYPH[mode]) ind.textContent = SORT_GLYPH[mode];
    });
  }

  function onSortClick(event) {
    const th = event.target.closest('th.sortable');
    if (!th) return;
    const key = th.dataset.sort;
    // Lần 1 tăng dần, lần 2 giảm dần, lần 3 bỏ sắp xếp (mặc định: Ngày duyệt mới nhất trước).
    if (state.sort !== key) { state.sort = key; state.dir = 'asc'; }
    else if (state.dir === 'asc') state.dir = 'desc';
    else { state.sort = ''; state.dir = 'asc'; }
    state.page = 1;
    paintSortHeaders();
    fetchPage();
  }

  function applyFilter(name, value) {
    if (state.filters[name] === value) return;
    state.filters[name] = value;
    state.page = 1;
    fetchPage();
  }

  // ---------- xuất Excel (đúng bộ lọc + sort đang dùng, toàn bộ tập, không phân trang) ----------
  async function exportExcel() {
    const button = $('approvedPriceExportButton');
    button.disabled = true;
    try {
      const res = await fetch(API + '/export?' + queryString(), { credentials: 'same-origin' });
      if (res.status === 401) { await readJson(res); return; }
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) || {}).error || 'Không xuất được file.');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'TKS_Gia_duyet.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      toast(err.message || 'Không xuất được file.', 'error');
    } finally {
      button.disabled = false;
    }
  }

  // ---------- hộp Tạo / Sửa ----------
  function recalcMessage(recalc) {
    if (!recalc) return '';
    switch (recalc.status) {
      case 'applied': return ' Đã tính lại ' + NUMBER.format(recalc.recomputedLines || 0) + ' dòng Kiểm tra giá bán (' + NUMBER.format(recalc.resultChangedLines || 0) + ' dòng đổi kết quả).';
      case 'not_published': return ' Kiểm tra giá bán chưa có dữ liệu; giá duyệt sẽ áp ở lượt chạy đầu tiên.';
      case 'busy': return ' Kiểm tra giá bán đang chạy; giá duyệt sẽ áp ở lượt chạy sau (hoặc chạy lại tính lại).';
      case 'failed': return ' ' + (recalc.message || 'Chưa tính lại được Kiểm tra giá bán; giá duyệt sẽ áp ở lượt chạy sau.');
      default: return '';
    }
  }

  // Ô chọn có gợi ý: gõ để tìm trong KiotViet của cơ sở đang chọn; chỉ giá trị chọn từ danh sách mới được lưu.
  function createPicker(field, { kind, getBranch, onPick, onClear }) {
    const input = field.querySelector('input');
    const list = field.querySelector('.approved-price-suggest');
    let timer = null;
    let seq = 0;
    let items = [];
    let active = -1;
    const picker = { id: '', label: '' };

    function close() { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; }
    function paintActive() {
      Array.from(list.children).forEach((li, i) => li.setAttribute('aria-selected', i === active ? 'true' : 'false'));
    }
    function choose(item) {
      picker.id = item.id;
      picker.label = kind === 'customer' ? item.name + (item.code ? ' (' + item.code + ')' : '') : item.code;
      input.value = picker.label;
      field.classList.add('is-picked');
      close();
      onPick(item);
    }
    function clearSelection() {
      if (!picker.id) return;
      picker.id = '';
      picker.label = '';
      field.classList.remove('is-picked');
      onClear();
    }
    function show(results, message) {
      items = results;
      list.innerHTML = results.length
        ? results.map((r, i) => '<li role="option" data-i="' + i + '" aria-selected="false"><span>' + escape(r.name) + '</span><span class="code">' + escape(r.code) + '</span></li>').join('')
        : '<li class="empty">' + escape(message || 'Không có kết quả trong danh sách KiotViet') + '</li>';
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      active = -1;
    }
    async function search() {
      const q = input.value.trim();
      const mine = ++seq;
      if (!q) { close(); return; }
      try {
        const res = await readJson(await fetch(API + '/' + kind + '-suggest?' + new URLSearchParams({ branch: getBranch(), q: q, limit: '20' }), { credentials: 'same-origin' }));
        if (mine === seq) show(res.results || []);
      } catch (err) {
        if (mine === seq) show([], err.message || 'Không tải được gợi ý');
      }
    }
    input.addEventListener('input', () => {
      clearSelection();
      clearTimeout(timer);
      timer = setTimeout(search, 250);
    });
    input.addEventListener('focus', () => { if (input.value.trim() && !picker.id) search(); });
    input.addEventListener('keydown', event => {
      if (list.hidden || !items.length) return;
      if (event.key === 'ArrowDown') { event.preventDefault(); active = (active + 1) % items.length; paintActive(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); active = (active - 1 + items.length) % items.length; paintActive(); }
      else if (event.key === 'Enter' && active >= 0) { event.preventDefault(); choose(items[active]); }
      else if (event.key === 'Escape') { event.stopPropagation(); close(); }
    });
    // mousedown (trước blur) để chọn được mục kể cả khi ô nhập mất focus.
    list.addEventListener('mousedown', event => {
      const li = event.target.closest('li[data-i]');
      if (!li) return;
      event.preventDefault();
      choose(items[Number(li.dataset.i)]);
    });
    input.addEventListener('blur', () => setTimeout(close, 120));
    picker.set = item => { if (item) choose(item); else { clearSelection(); input.value = ''; } };
    picker.reset = () => { clearSelection(); input.value = ''; close(); };
    return picker;
  }

  // Form Tạo / Sửa dùng cùng khung với form Thêm nhân sự (HR) và Tài khoản: .modal-overlay > .modal-box > header (tiêu đề + ✕)
  // > lưới 2 cột (.form-group + .form-control) > chân có nền riêng chứa nút. KHÔNG dùng <dialog>.showModal(): lớp "top layer"
  // của nó che mất lịch chọn ngày của dateInput.js (gắn vào <body>), nên dùng lớp phủ thường như các form kia.
  function fieldHtml(id, label, control, opts) {
    const o = opts || {};
    return '<div class="form-group ap-field' + (o.wide ? ' ap-wide' : '') + '" id="' + id + 'Field"><label for="' + id + '">' + escape(label) + '</label>' + control +
      (o.hint ? '<small class="ap-hint">' + escape(o.hint) + '</small>' : '') + '</div>';
  }
  const pickerControl = (id, placeholder) => '<input class="form-control" id="' + id + '" type="text" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="' + id + 'List" placeholder="' + escape(placeholder) + '" maxlength="100">' +
    '<ul class="approved-price-suggest" id="' + id + 'List" role="listbox" hidden></ul>';

  const priceControl = (id, value) => '<input class="form-control" id="' + id + '" type="number" inputmode="decimal" min="0" step="any" placeholder="Để trống nếu không áp" value="' + escape(isBlank(value) ? '' : value) + '">';

  function openEditor(row) {
    if (!canManage()) return;
    const old = $('approvedPriceDialog');
    if (old) old.remove();
    const opener = document.activeElement;
    const dialog = document.createElement('div');
    dialog.id = 'approvedPriceDialog';
    dialog.className = 'ap-overlay';
    const approvers = (state.data && state.data.options && state.data.options.approvers) || APPROVERS;
    const approverOptions = ['<option value="">Chọn người duyệt</option>'].concat(approvers.map(a => '<option value="' + escape(a) + '"' + (row && row.approver === a ? ' selected' : '') + '>' + escape(a) + '</option>')).join('');
    const branchOptions = BRANCHES.map(b => '<option value="' + b[0] + '"' + ((row ? row.branch : 'hanoi') === b[0] ? ' selected' : '') + '>' + b[1] + '</option>').join('');
    dialog.innerHTML =
      '<div class="ap-box" role="dialog" aria-modal="true" aria-labelledby="approvedPriceDialogTitle">' +
      '<div class="ap-header"><h3 id="approvedPriceDialogTitle">' + (row ? 'Sửa bản ghi giá duyệt' : 'Tạo bản ghi giá duyệt') + '</h3>' +
      '<button type="button" class="ap-close" data-close aria-label="Đóng" title="Đóng">✕</button></div>' +
      '<form novalidate><div class="ap-body">' +
      fieldHtml('apBranch', 'Cơ sở *', '<select class="form-control" id="apBranch">' + branchOptions + '</select>') +
      fieldHtml('apDate', 'Ngày duyệt *', '<input class="form-control" id="apDate" type="date" value="' + escape(row ? row.approvedOn : todayVn()) + '">') +
      fieldHtml('apCustomer', 'Khách hàng *', pickerControl('apCustomer', 'Gõ tên hoặc mã khách trên KiotViet'), { wide: true, hint: 'Chọn từ danh sách gợi ý của cơ sở này; khách phải có trên KiotViet.' }) +
      fieldHtml('apProductCode', 'Mã SP *', pickerControl('apProductCode', 'Gõ mã hoặc tên sản phẩm')) +
      fieldHtml('apProductName', 'Tên SP', '<input class="form-control" id="apProductName" type="text" readonly tabindex="-1" placeholder="Tự điền theo mã SP trên KiotViet">') +
      fieldHtml('apPriceNoVat', 'Giá không VAT (₫/chiếc)', priceControl('apPriceNoVat', row && row.priceNoVat)) +
      fieldHtml('apPriceWithVat', 'Giá có VAT (₫/chiếc)', priceControl('apPriceWithVat', row && row.priceWithVat)) +
      '<small class="ap-hint ap-wide" id="apPriceHint">Nhập ít nhất 1 trong 2 giá. Hóa đơn Full VAT dùng giá có VAT, hóa đơn không VAT dùng giá không VAT; loại để trống thì không áp giá duyệt cho loại hóa đơn đó. Là giá cuối/chiếc.</small>' +
      fieldHtml('apApprover', 'Người duyệt *', '<select class="form-control" id="apApprover">' + approverOptions + '</select>', { hint: 'Giá duyệt chỉ áp cho hóa đơn có ngày bán từ ngày duyệt trở đi.' }) +
      '<div class="ap-error ap-wide" id="apError" role="alert" hidden></div>' +
      '</div><div class="ap-footer"><button type="button" class="btn-secondary" data-close>Hủy</button>' +
      '<button type="submit" class="btn-primary" id="apSubmit">' + (row ? 'Lưu thay đổi' : 'Tạo bản ghi') + '</button></div></form></div>';
    document.body.appendChild(dialog);
    // Ô ngày hiển thị dd/mm/yyyy + lịch chọn ngày như mọi form khác (dateInput.js; value vẫn là ISO yyyy-mm-dd).
    if (window.TKSDateInput && typeof window.TKSDateInput.enhanceAll === 'function') window.TKSDateInput.enhanceAll(dialog);
    const q = id => dialog.querySelector('#' + id);
    const branchSel = q('apBranch');
    const productName = q('apProductName');
    const customer = createPicker(q('apCustomerField'), { kind: 'customer', getBranch: () => branchSel.value, onPick() {}, onClear() {} });
    const productPicker = createPicker(q('apProductCodeField'), {
      kind: 'product', getBranch: () => branchSel.value,
      onPick(item) { productName.value = item.name; },
      onClear() { productName.value = ''; }
    });
    if (row) {
      customer.set({ id: row.customerId, name: row.customerName, code: row.customerCode });
      productPicker.set({ id: row.productId, name: row.productName, code: row.productCode });
    }
    // Đổi cơ sở: khách / SP của cơ sở cũ không còn hợp lệ → xóa lựa chọn.
    branchSel.addEventListener('change', () => { customer.reset(); productPicker.reset(); productName.value = ''; });

    const onKey = event => { if (event.key === 'Escape') close(); };
    function close() {
      document.removeEventListener('keydown', onKey);
      dialog.remove();
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
    }
    dialog.close = close;
    document.addEventListener('keydown', onKey);
    dialog.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));

    const err = q('apError');
    const submit = q('apSubmit');
    const showError = message => { err.textContent = message; err.hidden = !message; };
    dialog.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault();
      showError('');
      const noVat = q('apPriceNoVat').value.trim();
      const withVat = q('apPriceWithVat').value.trim();
      const body = {
        branch: branchSel.value, customerId: customer.id, productId: productPicker.id,
        priceNoVat: noVat || null, priceWithVat: withVat || null, approver: q('apApprover').value, approvedOn: q('apDate').value
      };
      if (!customer.id) { showError('Chọn khách hàng từ danh sách gợi ý (khách phải có trên KiotViet).'); q('apCustomer').focus(); return; }
      if (!productPicker.id) { showError('Chọn mã SP từ danh sách gợi ý (mã phải có trên KiotViet).'); q('apProductCode').focus(); return; }
      if (!noVat && !withVat) { showError('Nhập ít nhất một trong hai giá (không VAT / có VAT).'); q('apPriceNoVat').focus(); return; }
      if (noVat && !(Number(noVat) > 0)) { showError('Giá phải lớn hơn 0.'); q('apPriceNoVat').focus(); return; }
      if (withVat && !(Number(withVat) > 0)) { showError('Giá phải lớn hơn 0.'); q('apPriceWithVat').focus(); return; }
      if (!body.approver) { showError('Chọn người duyệt.'); q('apApprover').focus(); return; }
      if (!body.approvedOn) { showError('Chọn ngày duyệt (dd/mm/yyyy).'); q('apDate').focus(); return; }
      if (row) body.expectedVersion = row.version;
      submit.disabled = true;
      submit.textContent = 'Đang lưu…';
      try {
        const out = await readJson(await fetch(row ? API + '/' + encodeURIComponent(row.id) : API, {
          method: row ? 'PUT' : 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        }));
        close();
        toast((row ? 'Đã lưu bản ghi giá duyệt.' : 'Đã tạo bản ghi giá duyệt.') + recalcMessage(out.recalc), 'success');
        afterWrite(out.recalc);
      } catch (e) {
        showError(e.status === 409 && e.body && e.body.code === 'VERSION_CONFLICT'
          ? 'Bản ghi vừa được người khác cập nhật. Hãy đóng hộp này và mở lại để xem bản mới nhất.'
          : (e.message || 'Không lưu được bản ghi.'));
        if (e.status === 409) fetchPage();
        submit.disabled = false;
        submit.textContent = row ? 'Lưu thay đổi' : 'Tạo bản ghi';
      }
    });
    q(row ? 'apPriceNoVat' : 'apCustomer').focus();
  }

  // ---------- nhập file (Excel / CSV): xem trước từng dòng, xác nhận rồi mới ghi ----------
  // Máy chủ đọc file ở cả 2 bước (không giữ trạng thái giữa chừng): bước 1 gửi file để xem trước, bước 2 gửi lại cùng file với ?commit=1.
  const IMPORT_STATUS = { create: 'Tạo mới', update: 'Ghi đè', unchanged: 'Không đổi', error: 'Lỗi' };

  async function postImportFile(file, commit) {
    const form = new FormData();
    form.append('file', file, file.name);
    return readJson(await fetch(API + '/import' + (commit ? '?commit=1' : ''), { method: 'POST', credentials: 'same-origin', body: form }));
  }

  function importRowHtml(r) {
    return '<tr class="ap-import-' + escape(r.status) + '"><td class="col-num">' + escape(r.row) + '</td>' +
      '<td><span class="ap-import-badge ap-import-badge-' + escape(r.status) + '">' + escape(IMPORT_STATUS[r.status] || r.status) + '</span></td>' +
      '<td>' + escape(r.customerName || r.customerCode || '—') + (r.customerName && r.customerCode ? ' <span class="muted">· ' + escape(r.customerCode) + '</span>' : '') + '</td>' +
      '<td>' + escape(r.branchLabel || '—') + '</td>' +
      '<td class="mono">' + escape(r.productCode || '—') + '</td>' +
      '<td class="mono col-num">' + escape(fmtPrice(r.priceNoVat)) + '</td>' +
      '<td class="mono col-num">' + escape(fmtPrice(r.priceWithVat)) + '</td>' +
      '<td>' + escape(r.approver || '—') + '</td>' +
      '<td class="mono">' + escape(r.approvedOn ? fmtDay(r.approvedOn) : '—') + '</td>' +
      '<td class="ap-import-note">' + escape(r.message || '') + '</td></tr>';
  }

  function openImport(file) {
    if (!canManage() || !file) return;
    const old = $('approvedPriceImportDialog');
    if (old) old.remove();
    const opener = document.activeElement;
    const dialog = document.createElement('div');
    dialog.id = 'approvedPriceImportDialog';
    dialog.className = 'ap-overlay';
    dialog.innerHTML =
      '<div class="ap-box ap-box-wide" role="dialog" aria-modal="true" aria-labelledby="approvedPriceImportTitle">' +
      '<div class="ap-header"><h3 id="approvedPriceImportTitle">Nhập giá duyệt từ file</h3>' +
      '<button type="button" class="ap-close" data-close aria-label="Đóng" title="Đóng">✕</button></div>' +
      '<div class="ap-import-body">' +
      '<small class="ap-hint" id="apImportFile"></small>' +
      '<small class="ap-hint">Cột bắt buộc: <b>Mã KH, Cơ sở, Mã SP, Người duyệt, Ngày duyệt (dd/mm/yyyy)</b> và ít nhất một trong <b>Giá không VAT / Giá có VAT</b>. ' +
      'Dòng trùng (cơ sở, khách, mã SP, ngày duyệt) với bản ghi đã có sẽ <b>ghi đè</b> giá và người duyệt; dòng lỗi bị bỏ qua. Có thể sửa trực tiếp file "Xuất file" rồi nhập lại.</small>' +
      '<div class="ap-import-summary" id="apImportSummary" role="status" aria-live="polite">Đang kiểm tra file…</div>' +
      '<div class="ap-error" id="apImportError" role="alert" hidden></div>' +
      '<div class="ap-import-scroll" id="apImportTableBox" hidden><table class="ap-import-table"><thead><tr><th>Dòng</th><th>Kết quả</th><th>Khách hàng</th><th>Cơ sở</th><th>Mã SP</th>' +
      '<th>Giá không VAT</th><th>Giá có VAT</th><th>Người duyệt</th><th>Ngày duyệt</th><th>Ghi chú</th></tr></thead><tbody id="apImportRows"></tbody></table></div></div>' +
      '<div class="ap-footer"><button type="button" class="btn-secondary" data-close>Hủy</button>' +
      '<button type="button" class="btn-primary" id="apImportConfirm" disabled>Nhập</button></div></div>';
    document.body.appendChild(dialog);
    const q = id => dialog.querySelector('#' + id);
    q('apImportFile').textContent = 'File: ' + file.name;
    const onKey = event => { if (event.key === 'Escape') close(); };
    function close() {
      document.removeEventListener('keydown', onKey);
      dialog.remove();
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
    }
    document.addEventListener('keydown', onKey);
    dialog.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
    const confirm = q('apImportConfirm');
    const showError = message => { const el = q('apImportError'); el.textContent = message; el.hidden = !message; };

    postImportFile(file, false).then(preview => {
      if (!dialog.isConnected) return;
      const s = preview.summary;
      q('apImportSummary').textContent = 'Tổng ' + NUMBER.format(s.total) + ' dòng: tạo mới ' + NUMBER.format(s.create) + ' · ghi đè ' + NUMBER.format(s.update) +
        ' · không đổi ' + NUMBER.format(s.unchanged) + ' · lỗi (bỏ qua) ' + NUMBER.format(s.error) + '.';
      q('apImportRows').innerHTML = preview.rows.map(importRowHtml).join('');
      q('apImportTableBox').hidden = false;
      const writable = s.create + s.update;
      confirm.disabled = writable === 0;
      confirm.textContent = writable ? 'Nhập ' + NUMBER.format(writable) + ' dòng' : 'Không có dòng hợp lệ để nhập';
    }).catch(err => {
      if (!dialog.isConnected) return;
      q('apImportSummary').textContent = '';
      showError(err.message || 'Không đọc được file.');
    });

    confirm.addEventListener('click', async () => {
      showError('');
      confirm.disabled = true;
      const label = confirm.textContent;
      confirm.textContent = 'Đang nhập…';
      try {
        const out = await postImportFile(file, true);
        const s = out.summary;
        close();
        toast('Đã nhập giá duyệt: tạo mới ' + NUMBER.format(s.create) + ', ghi đè ' + NUMBER.format(s.update) +
          (s.error ? ', bỏ qua ' + NUMBER.format(s.error) + ' dòng lỗi' : '') + '.' + recalcMessage(out.recalc), 'success');
        afterWrite(out.recalc);
      } catch (err) {
        showError(err.message || 'Không nhập được file.');
        confirm.disabled = false;
        confirm.textContent = label;
      }
    });
    confirm.focus();
  }

  // Sau khi ghi: nạp lại bảng này, và bảng Kiểm tra giá bán nếu đã tính lại các dòng của nó.
  function afterWrite(recalc) {
    fetchPage();
    if (recalc && recalc.status === 'applied' && window.TKSPriceAudit && typeof window.TKSPriceAudit.load === 'function') window.TKSPriceAudit.load(true);
  }

  async function remove(row) {
    if (!canManage()) return;
    const label = (row.customerName || '(khách không còn trên KiotViet)') + ' · ' + (row.productCode || '—') + ' · ' + pricesLabel(row) + ' · ' + fmtDay(row.approvedOn);
    if (!window.confirm('Xóa bản ghi giá duyệt?\n' + label + '\n\nCác dòng Kiểm tra giá bán liên quan sẽ được tính lại theo giá min thông thường.')) return;
    try {
      const out = await readJson(await fetch(API + '/' + encodeURIComponent(row.id) + '?expectedVersion=' + encodeURIComponent(row.version), { method: 'DELETE', credentials: 'same-origin' }));
      toast('Đã xóa bản ghi giá duyệt.' + recalcMessage(out.recalc), 'success');
      afterWrite(out.recalc);
    } catch (err) {
      toast(err.status === 409 ? 'Bản ghi vừa được người khác cập nhật; bảng đã được tải lại, hãy kiểm tra rồi xóa lại.' : (err.message || 'Không xóa được bản ghi.'), 'error');
      if (err.status === 409 || err.status === 404) fetchPage();
    }
  }

  function onRowsClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const tr = button.closest('tr[data-id]');
    const row = tr && state.data && state.data.rows.find(r => String(r.id) === tr.dataset.id);
    if (!row) return;
    if (button.dataset.action === 'edit') openEditor(row);
    else if (button.dataset.action === 'delete') remove(row);
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;
    $('approvedPriceHead').addEventListener('click', onSortClick);
    paintSortHeaders();
    $('approvedPriceApproverFilter').addEventListener('change', e => applyFilter('approver', e.target.value));
    $('approvedPriceFrom').addEventListener('change', e => applyFilter('from', e.target.value));
    $('approvedPriceTo').addEventListener('change', e => applyFilter('to', e.target.value));
    let searchTimer = null;
    $('approvedPriceSearch').addEventListener('input', e => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => applyFilter('q', e.target.value.trim()), 250);
    });
    $('approvedPriceClearFilters').addEventListener('click', () => {
      if (!state.filters.approver && !state.filters.from && !state.filters.to && !state.filters.q) return;
      clearTimeout(searchTimer);
      state.filters = { approver: '', from: '', to: '', q: '' };
      state.page = 1;
      fetchPage();
    });
    $('approvedPricePageSize').addEventListener('change', e => { state.pageSize = Number(e.target.value) || 50; state.page = 1; fetchPage(); });
    const go = page => () => {
      const target = Math.min(Math.max(1, page()), totalPages());
      if (target === state.page) return;
      state.page = target;
      fetchPage();
    };
    $('approvedPriceFirstPage').addEventListener('click', go(() => 1));
    $('approvedPricePrevPage').addEventListener('click', go(() => state.page - 1));
    $('approvedPriceNextPage').addEventListener('click', go(() => state.page + 1));
    $('approvedPriceLastPage').addEventListener('click', go(() => totalPages()));
    $('approvedPriceCreateButton').addEventListener('click', () => openEditor(null));
    $('approvedPriceExportButton').addEventListener('click', exportExcel);
    $('approvedPriceImportButton').addEventListener('click', () => $('approvedPriceImportFile').click());
    $('approvedPriceImportFile').addEventListener('change', event => {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (file) openImport(file);
    });
    $('approvedPriceRows').addEventListener('click', onRowsClick);
  }

  /** Mở tab Hóa đơn: tải nếu có quyền xem và dữ liệu đã cũ hơn 60 giây (force = luôn tải). */
  function load(force) {
    const section = $('approvedPriceSection');
    if (!section) return Promise.resolve();
    // Không có quyền xem: GỠ HẲN mục khỏi trang (không chỉ ẩn) — bảng này chỉ Quản lý thấy theo mặc định.
    if (!can(FEATURE_VIEW)) { section.remove(); return Promise.resolve(); }
    section.hidden = false;
    init();
    if (!force && (state.loading || Date.now() - state.loadedAt < 60000)) return Promise.resolve();
    return fetchPage();
  }

  window.TKSApprovedPrices = { load };
})();
