'use strict';
// Doc log Render (web hoac worker) va tom tat: hang cho pool DB + RSS theo gio VN, thoi gian [timing] theo endpoint.
// Dung: node scripts/renderPerfReport.js <serviceId> <soGio>   (can RENDER_API_KEY trong server/.env)
const OWNER_ID = 'tea-d9k155u417fc73duhjgg';
const VN_OFFSET_MS = 7 * 3600 * 1000;

const vnHour = ts => new Date(Date.parse(ts) + VN_OFFSET_MS).toISOString().slice(0, 13).replace('T', ' ');
const numberAfter = (message, name) => {
  const match = new RegExp('(?:^|\\s)' + name + '=([\\d.]+)').exec(message);
  return match ? Number(match[1]) : null;
};
const normalizePath = path => path.replace(/\?.*$/, '').split('/').map(seg => (/\d/.test(seg) ? ':id' : seg)).join('/');

function summarizeHourly(entries) {
  const byHour = new Map();
  const bucket = hour => {
    if (!byHour.has(hour)) byHour.set(hour, { hour, samples: 0, waitingMax: 0, waitingOver10: 0, rssMaxMb: 0 });
    return byHour.get(hour);
  };
  for (const { timestamp, message } of entries) {
    if (message.startsWith('[Performance]')) {
      const waiting = numberAfter(message, 'poolWaiting');
      if (waiting === null) continue;
      const row = bucket(vnHour(timestamp));
      row.samples += 1;
      row.waitingMax = Math.max(row.waitingMax, waiting);
      if (waiting > 10) row.waitingOver10 += 1;
    } else if (message.startsWith('[Memory] rss=')) {
      const match = /rss=(\d+)MB/.exec(message);
      if (match) { const row = bucket(vnHour(timestamp)); row.rssMaxMb = Math.max(row.rssMaxMb, Number(match[1])); }
    }
  }
  return [...byHour.values()].sort((a, b) => a.hour.localeCompare(b.hour));
}

function summarizeTiming(entries) {
  const seen = new Set();
  const byEndpoint = new Map();
  for (const { timestamp, message } of entries) {
    const match = /^\[timing\] (\S+) (\S+)/.exec(message);
    const total = numberAfter(message, 'total');
    if (!match || total === null) continue;
    const endpoint = match[1] + ' ' + normalizePath(match[2]);
    // Mot request co the in 2 dong [timing] (logger route + logger chung) lech nhau 0.1ms.
    const dedupeKey = endpoint + '|' + timestamp.slice(0, 19) + '|' + Math.round(total);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const row = byEndpoint.get(endpoint) || { endpoint, count: 0, sumMs: 0, maxMs: 0, over5s: 0 };
    row.count += 1;
    row.sumMs += total;
    row.maxMs = Math.max(row.maxMs, total);
    if (total > 5000) row.over5s += 1;
    byEndpoint.set(endpoint, row);
  }
  return [...byEndpoint.values()]
    .sort((a, b) => b.sumMs - a.sumMs)
    .map(({ endpoint, count, sumMs, maxMs, over5s }) => ({ endpoint, count, avgMs: Math.round(sumMs / count), maxMs: Math.round(maxMs), over5s }));
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchLogs({ apiKey, serviceId, text, hours, maxPages = 40, fetchImpl = fetch, warn = console.warn }) {
  const entries = [];
  let end = new Date();
  const start = new Date(end.getTime() - hours * 3600 * 1000);
  let hasMore = false;
  for (let page = 0; page < maxPages; page += 1) {
    const url = 'https://api.render.com/v1/logs?' + new URLSearchParams({
      ownerId: OWNER_ID, resource: serviceId, startTime: start.toISOString(), endTime: end.toISOString(),
      limit: '100', direction: 'backward', text
    });
    let response;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      response = await fetchImpl(url, { headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' } });
      if (response.status !== 429) break;
      await sleep(5000); // Render API gioi han toc do: cho roi thu lai
    }
    if (!response.ok) throw new Error('Render API ' + response.status + ': ' + (await response.text()).slice(0, 200));
    const body = await response.json();
    for (const log of body.logs || []) entries.push({ timestamp: log.timestamp, message: log.message });
    hasMore = Boolean(body.hasMore);
    if (!hasMore) break;
    end = new Date(body.nextEndTime);
    await sleep(400);
  }
  if (hasMore) warn('Cắt bớt: đã đọc ' + entries.length + ' dòng, còn log cũ hơn chưa lấy (tăng maxPages hoặc giảm số giờ).');
  return entries;
}

async function main() {
  require('dotenv').config({ path: require('node:path').join(__dirname, '../.env') });
  const [serviceId, hoursText] = process.argv.slice(2);
  const hours = Number(hoursText);
  if (!/^srv-/.test(serviceId || '') || !(hours > 0)) throw new Error('Dung: node scripts/renderPerfReport.js <srv-...> <soGio>');
  const apiKey = process.env.RENDER_API_KEY;
  if (!apiKey) throw new Error('Thieu RENDER_API_KEY trong server/.env');
  const perf = await fetchLogs({ apiKey, serviceId, hours, text: '[Performance]' });
  const memory = await fetchLogs({ apiKey, serviceId, hours, text: '[Memory] rss=' });
  const timing = await fetchLogs({ apiKey, serviceId, hours, text: '[timing]' });
  console.log('== Hang cho pool DB va RSS theo gio (gio VN)');
  console.table(summarizeHourly([...perf, ...memory]));
  console.log('== [timing] theo endpoint (20 dong ton thoi gian nhat)');
  console.table(summarizeTiming(timing).slice(0, 20));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { summarizeHourly, summarizeTiming, fetchLogs };
