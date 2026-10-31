/* Nguồn dòng vị trí: khi prototype được phục vụ từ server thì ĐỌC từ module VT Hà Nội / VT Sài Gòn (GET /api/stock-positions?branch=HN|SG,
   cần đăng nhập và quyền stockLocationsV2.view); mở file HTML trực tiếp hoặc API lỗi thì dùng dữ liệu demo.
   Chỉ đọc: mọi sửa, nhặt và lịch sử nằm trong bộ nhớ phiên của prototype, không ghi ngược về DB hay Google Sheets. */
(function(root){
  'use strict';
  const BRANCHES = ['HN', 'SG'];
  const LABEL = { api:'Từ VT Hà Nội / VT Sài Gòn', demo:'Dữ liệu demo' };
  /* Dòng API /api/stock-positions {code, name, quantity, notes, location, arrivalDate, ...} → dòng vị trí của prototype.
     SL không lấy từ quantity (chỉ giữ làm dự phòng như cột SL của file import): SL luôn tính từ ghi chú. */
  function mapRows(branch, rows){
    return (Array.isArray(rows) ? rows : []).filter(row => row && String(row.code ?? '').trim())
      .map((row, index) => ({
        id:'api-' + branch + '-' + index, branch,
        code:String(row.code).trim(), name:String(row.name ?? '').trim(),
        location:String(row.location ?? '').trim(), notes:String(row.notes ?? ''),
        arrivalDate:String(row.arrivalDate ?? '').trim(), totalQuantity:row.quantity ?? row.totalQuantity ?? null
      }));
  }
  // Thay dòng vị trí demo bằng dòng thật (chỉ khi cả hai cơ sở đọc được). Trả về nhãn nguồn.
  function apply(data, results){
    const rows = BRANCHES.flatMap(branch => mapRows(branch, results[branch]?.rows));
    data.locations.splice(0, data.locations.length, ...rows);
    return LABEL.api;
  }
  async function load(fetchFn, protocol){
    if (protocol === 'file:') return { label:LABEL.demo, results:null };
    try {
      const results = {};
      await Promise.all(BRANCHES.map(async branch => {
        const response = await fetchFn('/api/stock-positions?branch=' + branch, { credentials:'same-origin' });
        if (!response.ok) throw Error('HTTP ' + response.status);
        results[branch] = await response.json();
      }));
      return { label:LABEL.api, results };
    } catch { return { label:LABEL.demo, results:null }; }
  }
  const api = { BRANCHES, LABEL, mapRows, apply, load };
  if (typeof module !== 'undefined') { module.exports = api; return; }
  root.PickingLocationSource = api;
  const D = root.PickingData;
  const show = label => {
    D.locationSource = label;
    for (const id of ['pickingLocationSource', 'locSourceLabel']) { const el = root.document.getElementById(id); if (el) el.textContent = 'Vị trí: ' + label; }
  };
  if (!D) return;
  show(LABEL.demo);
  load(root.fetch.bind(root), root.location.protocol).then(({ label, results }) => {
    if (!results) return show(LABEL.demo);
    apply(D.get(), results);show(label);
    root.PickingPopup?.attach?.();root.PickingLocations?.render?.();
  });
})(typeof window !== 'undefined' ? window : globalThis);
