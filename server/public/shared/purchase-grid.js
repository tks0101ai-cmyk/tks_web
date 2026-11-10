(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else if (typeof define === 'function' && define.amd) define([], factory);
  else root.PurchaseGrid = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function parseTSV(text) {
    text = String(text == null ? '' : text);
    if (!text) return [];
    const result = [], row = [];
    let value = '', quoted = false, closed = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { value += '"'; i++; }
          else { quoted = false; closed = true; }
        } else value += ch;
      } else if (ch === '\t' || ch === '\n' || ch === '\r') {
        row.push(value); value = ''; closed = false;
        if (ch !== '\t') {
          result.push(row.splice(0));
          if (ch === '\r' && text[i + 1] === '\n') i++;
        }
      } else if (ch === '"' && !value && !closed) quoted = true;
      else {
        if (closed) throw new Error('Unexpected text after closing TSV quote');
        value += ch;
      }
    }
    if (quoted) throw new Error('Unterminated TSV quote');
    if (value || row.length || closed || !/[\r\n]$/.test(text)) {
      row.push(value); result.push(row);
    }
    return result;
  }

  function bounds({ rows, columns, anchor, focus }) {
    if (!anchor || !focus) return null;
    const a = rows.findIndex(row => row.id === anchor.id);
    const b = rows.findIndex(row => row.id === focus.id);
    const x = columns.findIndex(column => column.k === anchor.key);
    const y = columns.findIndex(column => column.k === focus.key);
    if (Math.min(a, b, x, y) < 0) return null;
    return { top: Math.min(a, b), bottom: Math.max(a, b), left: Math.min(x, y), right: Math.max(x, y) };
  }

  function range(options) {
    const box = bounds(options), result = [];
    if (!box) return result;
    for (let r = box.top; r <= box.bottom; r++) {
      for (let c = box.left; c <= box.right; c++) {
        result.push({ id: options.rows[r].id, key: options.columns[c].k });
      }
    }
    return result;
  }

  // All plans are atomic: overflow or ambiguous keyed input throws, never clips.
  // Key headers identify the first column; remaining headers are descriptive only.
  function planPaste(options) {
    const box = bounds(options);
    if (!box) return [];
    const matrix = parseTSV(options.text);
    if (!matrix.length) return [];
    const { rows, columns } = options;
    const byKey = new Map();
    for (const row of rows) {
      if (typeof row.rowKey !== 'string' || !row.rowKey) continue;
      const matches = byKey.get(row.rowKey) || [];
      matches.push(row); byKey.set(row.rowKey, matches);
    }
    const header = matrix[0][0] === 'Mã dòng' || matrix[0][0] === 'rowKey';
    const keyed = header || matrix.some(row => row.length > 1 && byKey.has(row[0]));
    const result = [];
    if (keyed) {
      const seen = new Set();
      for (const values of matrix.slice(header ? 1 : 0)) {
        const key = values[0], matches = byKey.get(key);
        if (!matches || matches.length !== 1 || seen.has(key)) {
          throw new Error('Unknown or duplicate rowKey: ' + key);
        }
        seen.add(key);
        if (values.length < 2) throw new Error('Missing values for rowKey: ' + key);
        if (box.left + values.length - 1 > columns.length) throw new Error('Paste exceeds column bounds');
        values.slice(1).forEach((raw, c) => result.push({ id: matches[0].id, key: columns[box.left + c].k, raw }));
      }
      return result;
    }
    if (matrix.length === 1 && matrix[0].length === 1) {
      return range(options).map(cell => ({ ...cell, raw: matrix[0][0] }));
    }
    if (box.top + matrix.length > rows.length || matrix.some(row => box.left + row.length > columns.length)) {
      throw new Error('Paste exceeds grid bounds');
    }
    matrix.forEach((values, r) => values.forEach((raw, c) => {
      result.push({ id: rows[box.top + r].id, key: columns[box.left + c].k, raw });
    }));
    return result;
  }

  function fill(options) {
    const box = bounds(options), result = [];
    if (!box || !options.target) return result;
    const { rows, columns, target } = options;
    const end = rows.findIndex(row => row.id === target.id);
    if (end < 0 || !columns.some(column => column.k === target.key)) return result;
    if (end >= box.top && end <= box.bottom) return result;
    const height = box.bottom - box.top + 1;
    const start = end < box.top ? end : box.bottom + 1;
    const stop = end < box.top ? box.top - 1 : end;
    for (let r = start; r <= stop; r++) {
      const source = box.top + ((r - box.top) % height + height) % height;
      for (let c = box.left; c <= box.right; c++) {
        result.push({ id: rows[r].id, key: columns[c].k, fromId: rows[source].id, fromKey: columns[c].k });
      }
    }
    return result;
  }

  function summarize(cells) {
    let count = 0, numeric = 0, sum = 0;
    for (const cell of cells) {
      if (cell.text != null && String(cell.text) !== '') count++;
      if (typeof cell.number === 'number' && Number.isFinite(cell.number)) { numeric++; sum += cell.number; }
    }
    return { count, numeric, sum, average: numeric ? sum / numeric : null };
  }

  function serializeTSV(matrix) {
    return matrix.map(row => row.map(value => {
      const text = String(value == null ? '' : value);
      return /["\t\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    }).join('\t')).join('\n');
  }

  return { parseTSV, range, planPaste, fill, summarize, serializeTSV };
});
