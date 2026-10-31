'use strict';

const key = value => String(value ?? '').trim().toLowerCase();
function invalid(message) {
  return Object.assign(new Error(message), {statusCode:400, code:'VALIDATION'});
}

// Money stays as integer coefficient + decimal scale until serialized to JSON.
function decimal(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') ||
      String(value).trim() === '' || !Number.isFinite(Number(value))) {
    throw invalid('Giá và chiết khấu phải là số hữu hạn.');
  }
  const text = String(value).trim();
  const m = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!m || text.length > 512) throw invalid('Giá hoặc chiết khấu không hợp lệ.');
  const exponent = Number(m[4] || 0);
  if (Math.abs(exponent) > 324) throw invalid('Giá hoặc chiết khấu vượt phạm vi hỗ trợ.');
  let coefficient = BigInt(m[2] + (m[3] || '')) * (m[1] === '-' ? -1n : 1n);
  let scale = (m[3] || '').length - exponent;
  if (scale < 0) { coefficient *= 10n ** BigInt(-scale); scale = 0; }
  return {coefficient, scale};
}
function add(a, b, subtract = false) {
  const scale = Math.max(a.scale, b.scale);
  return {scale, coefficient:a.coefficient * 10n ** BigInt(scale-a.scale) +
    (subtract ? -1n : 1n) * b.coefficient * 10n ** BigInt(scale-b.scale)};
}
function text(value) {
  const negative = value.coefficient < 0n;
  let digits = (negative ? -value.coefficient : value.coefficient).toString();
  if (value.scale) {
    digits = digits.padStart(value.scale + 1, '0');
    digits = (digits.slice(0, -value.scale) + '.' + digits.slice(-value.scale)).replace(/\.?0+$/, '');
  }
  return (negative && digits !== '0' ? '-' : '') + digits;
}

function makeOrderSnapshot(order) {
  let total = decimal(0);
  const lines = [];
  for (const line of Array.isArray(order.lines) ? order.lines : []) {
    const code = key(line.productCode);
    if (!code || line.isService || code.startsWith('vat')) continue;
    const quantity = Number(line.quantity);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw invalid(`Mã ${line.productCode}: số lượng nhặt phải là số chiếc nguyên dương.`);
    }
    const unit = add(decimal(line.price), decimal(line.discount ?? 0), true);
    const amount = {scale:unit.scale, coefficient:unit.coefficient * BigInt(quantity)};
    total = add(total, amount);
    lines.push({productCode:String(line.productCode).trim(), productName:String(line.productName || '').trim(),
      quantity, ...(line.kiotQuantity===undefined?{}:{kiotQuantity:line.kiotQuantity}), price:line.price, discount:line.discount ?? 0, note:line.note || '',
      unitPrice:text(unit), amount:text(amount)});
  }
  const discount = decimal(order.invoiceDiscount ?? 0);
  return {...order, schemaVersion:2, lines, invoiceDiscount:text(discount),
    goodsTotal:text(total), payable:text(add(total, discount, true))};
}

module.exports = {makeOrderSnapshot};
