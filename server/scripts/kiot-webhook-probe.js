'use strict';

// THU WEBHOOK KIOTVIET de tim thu tu dong that cua don dat hang (Public API tra orderDetails theo productId,
// khong co Id dong). Secret doc tu .env, KHONG in ra man hinh.
//   node scripts/kiot-webhook-probe.js list
//   node scripts/kiot-webhook-probe.js register https://<ten-mien-cong-khai>   (dang ky order.update cho HN)
//   node scripts/kiot-webhook-probe.js show                                     (doc payload moi nhat trong webhook_events_raw)
//   node scripts/kiot-webhook-probe.js remove <webhookId>
const { getPool } = require('../db/pool');
const { CONFIG } = require('../config');
const { getConfiguredBranches } = require('../kiotvietSync/config');
const { createKiotVietClient } = require('../kiotviet/kiotVietApiClient');

const API = 'https://public.kiotapi.com';
const mask = text => String(text).replace(/webhook\/[^"/\s]+/g, 'webhook/***');

async function call(method, path, body) {
  const cfg = getConfiguredBranches({ warn() {} }).find(item => item.branch === 'hanoi');
  const client = createKiotVietClient(cfg);
  return client.fetchJsonWithRetry(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await client.getAccessToken()}`, Retailer: cfg.retailer, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
}

async function show() {
  const { rows } = await getPool().query('SELECT id, received_at, payload FROM webhook_events_raw ORDER BY id DESC LIMIT 5');
  if (!rows.length) return console.log('Chua co su kien webhook nao.');
  for (const row of rows) {
    const text = JSON.stringify(row.payload);
    console.log(`#${row.id} ${row.received_at}`);
    for (const m of text.matchAll(/\{[^{}]*"(?:ProductCode|productCode)"[^{}]*\}/g)) console.log('  ', m[0].slice(0, 300));
    if (!/productCode/i.test(text)) console.log('  ', text.slice(0, 1500));
  }
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'list') console.log(mask(JSON.stringify(await call('GET', '/webhooks'), null, 2)));
  else if (cmd === 'register') {
    if (!/^https:\/\//.test(arg || '')) throw new Error('Can ten mien https cong khai cua may chu.');
    if (!CONFIG.KIOTVIET_WEBHOOK_SECRET) throw new Error('Thieu KIOTVIET_WEBHOOK_SECRET trong .env.');
    const url = `${arg.replace(/\/+$/, '')}/api/kiotviet/webhook/${CONFIG.KIOTVIET_WEBHOOK_SECRET}`;
    const res = await call('POST', '/webhooks', { Webhook: { Type: 'order.update', Url: url, IsActive: true, Description: 'probe thu tu dong' } });
    console.log(mask(JSON.stringify(res)));
  } else if (cmd === 'remove') console.log(JSON.stringify(await call('DELETE', `/webhooks/${encodeURIComponent(arg)}`)));
  else if (cmd === 'show') await show();
  else console.log('Lenh: list | register <https-url> | show | remove <id>');
}

main().catch(error => { console.error(mask(error.message)); process.exitCode = 1; })
  .finally(() => setTimeout(() => process.exit(), 100));
