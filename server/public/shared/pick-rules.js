(function(root){
  'use strict';
  const key = value => String(value ?? '').trim().toLowerCase();
  function quantity(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
    const text = String(value ?? '').trim();
    if (!/^\d+(\.\d+)?$/.test(text)) return null;
    // Sheet-formatted numbers such as 1.000 are ambiguous; require manual confirmation.
    if (/^\d{1,3}(\.\d{3})+$/.test(text)) return null;
    return Number(text);
  }
  function suggest(need, candidates) {
    let remaining = need;
    const available = candidates.map(c => ({ ...c, available: quantity(c.available) }));
    const picks = [];
    while (remaining > 0.000001) {
      const eligible = available.filter(c => c.available > 0);
      if (!eligible.length) break;
      eligible.sort((a,b) => Number(b.available >= remaining) - Number(a.available >= remaining)
        || (a.available >= remaining ? a.available - b.available : b.available - a.available)
        || a.id.localeCompare(b.id));
      const chosen = eligible[0];
      const take = Math.min(remaining, chosen.available);
      picks.push({ id: chosen.id, quantity: take });
      remaining = Math.max(0, Math.round((remaining - take) * 1e6) / 1e6);
      chosen.available = 0;
    }
    return { picks, shortage: remaining };
  }
  /* Sai lệch tổng SL chỉ định so với SL cần nhặt, theo từng dòng: kind 'short' (thiếu hàng) hoặc 'over' (thừa hàng).
     Nhặt tròn thùng (thừa ít hơn một thùng) không tính là thừa. Không kiểm tra tính hợp lệ của vị trí (việc của validate). */
  function mismatches(lines, locations, allocations) {
    const out = [];
    lines.forEach((line, index) => {
      let total = 0, cartoned = true, maxCarton = 0;
      for (const pick of allocations[index] || []) {
        const row = locations.find(c => c.id === pick.id && key(c.code) === key(line.productCode));
        if (!row || !(pick.quantity > 0)) continue;
        total += pick.quantity;
        if (row.perCarton > 0) maxCarton = Math.max(maxCarton, row.perCarton); else cartoned = false;
      }
      const over = total - line.quantity;
      if (Math.abs(over) <= 0.000001) return;
      if (over < 0) out.push({ productCode: line.productCode, need: line.quantity, total, kind: 'short', diff: -over });
      else if (!(cartoned && maxCarton > 0 && over < maxCarton - 0.000001)) out.push({ productCode: line.productCode, need: line.quantity, total, kind: 'over', diff: over });
    });
    return out;
  }
  /* options.allowMismatch: bỏ lỗi "đã chỉ định x/y" (cho phép chỉ định thiếu/thừa sau khi người dùng xác nhận cảnh báo);
     các lỗi còn lại (vị trí không hợp lệ, vượt khả dụng, SL không nguyên) vẫn giữ. */
  function validate(lines, locations, allocations, options) {
    const allowMismatch = !!(options && options.allowMismatch);
    const used = new Map();
    const errors = [];
    lines.forEach((line, index) => {
      if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
        errors.push(line.productCode + ': số lượng cần nhặt phải là số dương');
      }
      let total = 0, cartoned = true, maxCarton = 0;
      for (const pick of allocations[index] || []) {
        const row = locations.find(c => c.id === pick.id && key(c.code) === key(line.productCode));
        if (!row || !row.location || quantity(row.available) === null || !Number.isFinite(pick.quantity) || pick.quantity < 0) { errors.push('Chỉ định không hợp lệ: ' + line.productCode); continue; }
        total += pick.quantity;
        if (!Number.isFinite(total) || total > 1e12) errors.push(line.productCode + ': tổng số lượng vượt giới hạn');
        if (pick.quantity > 0) { if (row.perCarton > 0) maxCarton = Math.max(maxCarton, row.perCarton); else cartoned = false; }
        used.set(row.id, (used.get(row.id) || 0) + pick.quantity);
        if (!Number.isFinite(used.get(row.id)) || used.get(row.id) > 1e12) errors.push(row.code + ': tổng phân bổ vượt giới hạn');
      }
      /* Nhặt tròn thùng: khi mọi vị trí được chọn có quy cách thùng, SL thực nhặt được vượt SL cần
         nhưng phải ít hơn một thùng (bỏ bớt được một thùng thì đã thiếu). */
      const over = total - line.quantity, roundedUp = cartoned && maxCarton > 0 && over > 0.000001 && over < maxCarton - 0.000001;
      if (!allowMismatch && Math.abs(over) > 0.000001 && !roundedUp) errors.push(line.productCode + ': đã chỉ định ' + total + '/' + line.quantity);
    });
    locations.forEach(row => {
      if (quantity(row.available) !== null && (used.get(row.id) || 0) > quantity(row.available) + 0.000001)
        errors.push(row.code + ' tại ' + row.location + ': vượt số lượng khả dụng');
    });
    return errors;
  }
  const api = { version:'best-fit-v4', key, quantity, suggest, validate, mismatches };
  if (typeof module !== 'undefined') module.exports = api;
  else root.PickingRules = api;
})(typeof window !== 'undefined' ? window : globalThis);
