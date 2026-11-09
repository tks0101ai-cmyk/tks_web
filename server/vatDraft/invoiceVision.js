'use strict';

// Doc anh hoa don GTGT bang AI vision (xKiro, chuan OpenAI chat/completions). AI CHI trich
// ten don vi ban + so tien; tai khoan nhan tien luon lay tu vatDraftConfig (khong de AI sinh).

const PROMPT = [
  'Bạn đọc ảnh hóa đơn giá trị gia tăng (GTGT) điện tử Việt Nam.',
  'Trả về DUY NHẤT một object JSON, không giải thích, với các khóa:',
  '- "sellerName": tên công ty ở dòng "Đơn vị bán hàng (Seller)" — tên in đậm ở đầu hóa đơn, KHÔNG phải người mua (Buyer).',
  '- "totalPayment": số ở dòng "Tổng cộng tiền thanh toán (Total payment)".',
  '- "totalBeforeVat": số ở dòng "Cộng tiền hàng (Total amount)".',
  '- "vatAmount": số ở dòng "Tiền thuế GTGT (VAT amount)".',
  '- "amountInWords": chép NGUYÊN VĂN chữ ở dòng "Số tiền viết bằng chữ (In words)", không đổi sang số.',
  'Số tiền giữ nguyên chuỗi như in trên hóa đơn (ví dụ "9.732.220").',
  'KHÔNG đoán hay suy từ dòng khác (vd Mã số thuế): dòng nào không có hoặc không đọc rõ trong ảnh thì để null.'
].join('\n');

// 404 = model da bi nha cung cap go (xKiro tra "Model ... does not exist") -> thu model ke tiep.
const RETRYABLE = new Set([404, 408, 429, 500, 502, 503, 504]);

function unavailable(message) {
  const error = new Error(message);
  error.statusCode = 503;
  error.code = 'INVOICE_AI_UNAVAILABLE';
  return error;
}

/** Lay object JSON tu cau tra loi model (chap nhan boc trong ```json hoac lan chu). */
function parseModelJson(content) {
  const text = Array.isArray(content) ? content.map(part => part && part.text || '').join('') : String(content || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function createInvoiceVisionClient({
  apiKey,
  baseUrl = 'https://api.xkiro.com/v1',
  model,
  fallbackModel = '',
  fetchImpl = fetch,
  timeoutMs = 45000
} = {}) {
  const endpoint = String(baseUrl).replace(/\/+$/, '') + '/chat/completions';

  async function callModel(modelId, dataUrl) {
    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: modelId,
          temperature: 0,
          // Model suy luan cua OpenAI mac dinh "nghi" 20-40s truoc khi tra loi; doc chu khong can nghi.
          ...(modelId.startsWith('openai/') ? { reasoning_effort: 'none' } : {}),
          messages: [
            { role: 'system', content: PROMPT },
            { role: 'user', content: [
              { type: 'text', text: 'Đọc hóa đơn trong ảnh và trả JSON theo yêu cầu.' },
              { type: 'image_url', image_url: { url: dataUrl } }
            ] }
          ]
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      return { retryable: true, reason: error.name === 'TimeoutError' ? 'timeout' : 'network' };
    }
    if (!res.ok) return { retryable: RETRYABLE.has(res.status), reason: `HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    const content = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
    const parsed = parseModelJson(content);
    return parsed ? { parsed } : { retryable: true, reason: 'invalid JSON' };
  }

  /** Buffer anh -> { sellerName, totalPayment, totalBeforeVat, vatAmount } (gia tri tho tu model). */
  async function extractInvoice(buffer, mimeType) {
    const dataUrl = `data:${mimeType};base64,${Buffer.from(buffer).toString('base64')}`;
    // fallbackModel: 1 ten hoac nhieu ten cach nhau dau phay, thu lan luot khi model truoc 429/503/het gio.
    const fallbacks = Array.isArray(fallbackModel) ? fallbackModel : String(fallbackModel || '').split(',');
    const models = [model, ...fallbacks].map(m => String(m || '').trim()).filter((m, i, list) => m && list.indexOf(m) === i);
    for (const modelId of models) {
      const result = await callModel(modelId, dataUrl);
      if (result.parsed) return result.parsed;
      console.warn(`[invoice-vision] ${modelId}: ${result.reason}`);
      if (!result.retryable) break;
    }
    throw unavailable('AI chưa đọc được hóa đơn lúc này — vui lòng thử lại hoặc nhập số tiền và chọn tài khoản thủ công.');
  }

  return { configured: !!(apiKey && model), extractInvoice };
}

module.exports = { createInvoiceVisionClient, parseModelJson, PROMPT };
