'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createInvoiceVisionClient, parseModelJson } = require('./invoiceVision');

function reply(content, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => ({ choices: [{ message: { content } }] }) };
}

function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { impl, calls };
}

const IMAGE = Buffer.from('fake-jpeg');

test('parseModelJson: JSON thuan, trong ```json va lan chu', () => {
  assert.deepEqual(parseModelJson('{"sellerName":"A"}'), { sellerName: 'A' });
  assert.deepEqual(parseModelJson('```json\n{"totalPayment":"1.320.002"}\n```'), { totalPayment: '1.320.002' });
  assert.deepEqual(parseModelJson('Kết quả: {"serialNo":"1C26THC"} xong'), { serialNo: '1C26THC' });
  assert.deepEqual(parseModelJson([{ type: 'text', text: '{"a":1}' }]), { a: 1 });
  assert.equal(parseModelJson('không đọc được'), null);
  assert.equal(parseModelJson('{hỏng}'), null);
  assert.equal(parseModelJson('[1,2]'), null);
});

test('extractInvoice gui anh dang data URL + Bearer, tra object model', async () => {
  const { impl, calls } = fakeFetch([reply('{"sellerName":"CÔNG TY SHC GROUP","totalPayment":"1.320.002"}')]);
  const client = createInvoiceVisionClient({ apiKey: 'k1', baseUrl: 'https://x.test/v1/', model: 'm1', fetchImpl: impl });
  assert.equal(client.configured, true);
  const result = await client.extractInvoice(IMAGE, 'image/jpeg');
  assert.deepEqual(result, { sellerName: 'CÔNG TY SHC GROUP', totalPayment: '1.320.002' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://x.test/v1/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k1');
  assert.equal(calls[0].body.model, 'm1');
  const image = calls[0].body.messages[1].content.find(part => part.type === 'image_url');
  assert.equal(image.image_url.url, 'data:image/jpeg;base64,' + IMAGE.toString('base64'));
});

test('429 / timeout / JSON hong o model chinh -> thu model du phong', async () => {
  for (const first of [reply('', 429), Object.assign(new Error('t'), { name: 'TimeoutError' }), reply('xin lỗi')]) {
    const { impl, calls } = fakeFetch([first, reply('{"totalPayment":"9.732.220"}')]);
    const client = createInvoiceVisionClient({ apiKey: 'k', model: 'main', fallbackModel: 'backup', fetchImpl: impl });
    assert.deepEqual(await client.extractInvoice(IMAGE, 'image/png'), { totalPayment: '9.732.220' });
    assert.deepEqual(calls.map(c => c.body.model), ['main', 'backup']);
  }
});

test('nhieu model du phong (chuoi cach nhau dau phay) thu lan luot den khi co model doc duoc', async () => {
  const { impl, calls } = fakeFetch([reply('', 429), reply('', 503), reply('{"totalPayment":"1.000"}')]);
  const client = createInvoiceVisionClient({ apiKey: 'k', model: 'main', fallbackModel: ' b1:free , b2 ,main', fetchImpl: impl });
  assert.deepEqual(await client.extractInvoice(IMAGE, 'image/png'), { totalPayment: '1.000' });
  assert.deepEqual(calls.map(c => c.body.model), ['main', 'b1:free', 'b2']);
});

test('model chinh bi go (404 not found) -> bo qua, thu tiep model du phong', async () => {
  const { impl, calls } = fakeFetch([reply('', 404), reply('', 404), reply('{"totalPayment":"5.000"}')]);
  const client = createInvoiceVisionClient({ apiKey: 'k', model: 'gone1', fallbackModel: 'gone2,alive', fetchImpl: impl });
  assert.deepEqual(await client.extractInvoice(IMAGE, 'image/png'), { totalPayment: '5.000' });
  assert.deepEqual(calls.map(c => c.body.model), ['gone1', 'gone2', 'alive']);
});

test('model openai/* gui reasoning_effort=none, model khac thi khong', async () => {
  const { impl, calls } = fakeFetch([reply('', 503), reply('{"totalPayment":"1.000"}')]);
  const client = createInvoiceVisionClient({ apiKey: 'k', model: 'mistralai/m', fallbackModel: 'openai/gpt-x', fetchImpl: impl });
  await client.extractInvoice(IMAGE, 'image/png');
  assert.equal(calls[0].body.reasoning_effort, undefined);
  assert.equal(calls[1].body.reasoning_effort, 'none');
});

test('loi khong thu lai (401) -> 503 ngay, khong goi du phong', async () => {
  const { impl, calls } = fakeFetch([reply('', 401)]);
  const client = createInvoiceVisionClient({ apiKey: 'k', model: 'main', fallbackModel: 'backup', fetchImpl: impl });
  await assert.rejects(client.extractInvoice(IMAGE, 'image/jpeg'), { statusCode: 503, code: 'INVOICE_AI_UNAVAILABLE' });
  assert.equal(calls.length, 1);
});

test('ca hai model loi -> 503; thieu key -> configured=false', async () => {
  const { impl } = fakeFetch([reply('', 500), reply('', 502)]);
  const client = createInvoiceVisionClient({ apiKey: 'k', model: 'main', fallbackModel: 'backup', fetchImpl: impl });
  await assert.rejects(client.extractInvoice(IMAGE, 'image/jpeg'), { statusCode: 503 });
  assert.equal(createInvoiceVisionClient({ apiKey: '', model: 'm' }).configured, false);
});
