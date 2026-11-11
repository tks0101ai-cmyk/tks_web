'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { createDebtRewardService } = require('./debtRewardService');
const { createDebtScheduleRepository } = require('./debtScheduleRepository');
const { takeDebtCycleSnapshot } = require('./debtCycleSnapshot');
const { finalizePendingPenaltyCycles } = require('./debtPenaltyLedger');
const businessSql = require('../businessReport/businessMonthlySql');


async function setup() {
  const db = new PGlite();
  await db.exec(`CREATE TABLE customers(branch text,id bigint,code text,name text,debt numeric,raw jsonb,PRIMARY KEY(branch,id));
    CREATE TABLE invoices(branch text,id bigint,code text,customer_id bigint,purchase_date timestamptz,total numeric,status int,raw jsonb);
    CREATE TABLE returns(branch text,id bigint,code text,customer_id bigint,return_date timestamptz,total numeric,raw jsonb);`);
  for (const file of ['0036_business_monthly_sales.sql','0047_debt_schedule_report.sql','0048_debt_penalty.sql',
    '0050_debt_cycle_manual_refresh.sql','0051_debt_penalty_ledger.sql','0052_debt_reward_months.sql']) {
    await db.exec(fs.readFileSync(path.join(__dirname,'../db/migrations',file),'utf8'));
  }
  const pool = {query:(s,p)=>db.query(s,p),connect:async()=>({query:(s,p)=>db.query(s,p),release(){}})};
  let instant = new Date('2026-10-14T09:00:00Z');
  const now=()=>instant;
  const repository=createDebtScheduleRepository({pool});
  const service=createDebtRewardService({pool,repository,now});
  for (const [branch,sale] of [['hanoi','An'],['saigon','Bình']]) for(let n=1;n<=6;n++) {
    await db.query('INSERT INTO customers VALUES ($1,$2,$3,$4,0,$5)',[branch,n,`KH${n}`,`${sale} khách ${n}`,JSON.stringify({groups:sale})]);
    for(let i=1;i<=5;i++) await db.query(`INSERT INTO invoices VALUES ($1,$2,$3,$4,'2026-10-10 12:00:00Z',6000000,1,$5)`,
      [branch,n*10+i,`HD${n}-${i}`,n,JSON.stringify({customerCode:`KH${n}`,statusValue:'Hoàn thành'})]);
  }
  const snapshot=async date=>takeDebtCycleSnapshot(pool,date,{log(){},takenAt:new Date(`${date}T08:00:00Z`),loadAverages:async()=>({branches:[],codes:[],values:[]})});
  await snapshot('2026-10-14');
  // Khach HN 1 no 300k (< 400k, khong co hoa don trong lich) => qua han 300k => phat 25k/ngay theo quy che (khong con phat tay).
  const owe=async(date='2026-10-14')=>{
    await db.query("UPDATE debt_cycle_customers SET current_debt=300000, overdue_debt=300000 WHERE cycle_date=$1::date AND branch='hanoi' AND customer_id=1",[date]);
    repository.bumpVersion();
  };
  return {db,pool,repository,service,snapshot,owe,setNow:value=>{instant=new Date(value);}};
}

test('real monthly SQL counts completed invoices, net returns and debt-free customers from both branches',async()=>{
  const f=await setup();try {
    await f.db.query(`INSERT INTO returns VALUES ('saigon',1,'TH1',1,'2026-10-12Z',1000000,'{"customerCode":"KH1","statusValue":"Đã trả"}')`);
    await f.db.query(`INSERT INTO invoices VALUES ('hanoi',999,'CANCEL',1,'2026-10-10Z',9000000000,2,'{"customerCode":"KH1","statusValue":"Đã hủy"}')`);
    const b=await f.service.readBoard();
    assert.equal(b.rows.find(r=>r.sale==='An').points,30);
    assert.equal(b.rows.find(r=>r.sale==='Bình').points,29);
    assert.equal(b.rows.find(r=>r.sale==='An').scoreCustomers[0].invoiceCount,5);
    assert.equal(b.status,'provisional');
    assert.equal(b.summary.recipientCount,1);assert.equal(b.rows.find(r=>r.sale==='An').reward,3000000);
    assert.equal(b.summary.pool,3000000);assert.equal(b.summary.allocatedReward,3000000);
    await f.service.readBoard();
    assert.equal((await f.db.query('SELECT COUNT(*)::int AS count FROM debt_reward_months')).rows[0].count,0);
    assert.equal(b.coverage.complete,false);assert.ok(b.coverage.missingDays.includes('2026-10-01'));
  } finally {await f.db.close();}
});

test('monthly board adds the open-cycle live penalty to sealed days and branch filtering preserves global ranking',async()=>{
  const f=await setup();try {
    await f.owe('2026-10-14');
    assert.equal((await f.service.readBoard()).rows.find(r=>r.sale==='An').grossPenalty,25000);
    await f.snapshot('2026-10-15');f.repository.bumpVersion();
    await finalizePendingPenaltyCycles(f.pool,{repository:f.repository,log(){}});
    const all=await f.service.readBoard();const one=await f.service.readBoard({branches:['hanoi']});
    assert.equal(one.rows.length,1);assert.equal(one.rows[0].rank,2);assert.deepEqual(one.summary,all.summary);
    await f.owe('2026-10-15');
    const board=await f.service.readBoard();
    assert.equal(board.rows.find(r=>r.sale==='An').grossPenalty,50000);
    assert.equal(board.lastPenaltyDate,'2026-10-15');
  } finally {await f.db.close();}
});

test('month closes after next-month snapshot, final ledger and frozen sales; remains immutable after edits',async()=>{
  const f=await setup();try {
    await f.owe('2026-10-14');
    await f.snapshot('2026-10-15'); f.repository.bumpVersion();
    await finalizePendingPenaltyCycles(f.pool,{repository:f.repository,log(){}});
    await f.snapshot('2026-10-31'); f.repository.bumpVersion();
    f.setNow('2026-11-01T07:59:00Z');
    assert.deepEqual(await f.service.finalizePendingMonths(),[]);
    await f.snapshot('2026-11-01');f.repository.bumpVersion();f.setNow('2026-11-01T08:01:00Z');
    await assert.rejects(f.service.finalizePendingMonths(),/phạt|penalty/i);
    await finalizePendingPenaltyCycles(f.pool,{repository:f.repository,log(){}});
    await assert.rejects(f.service.finalizePendingMonths(),/doanh số|sales/i);
    await f.pool.query(businessSql.FREEZE_CUSTOMER_SQL,[['hanoi','saigon'],'2026-10-01','2026-11-01']);
    await f.db.exec("INSERT INTO business_monthly_state(month) VALUES ('2026-10-01')");
    assert.deepEqual(await f.service.finalizePendingMonths(),['2026-10']);
    const closed=await f.service.readBoard({month:'2026-10'});
    assert.equal(closed.status,'finalized');assert.equal(closed.rows.find(r=>r.sale==='An').grossPenalty,25000);
    assert.equal(closed.rows.find(r=>r.sale==='An').points,30);
    assert.equal(closed.rows.reduce((sum,r)=>sum+r.reward,0),3000000);
    await f.db.exec("UPDATE customers SET raw='{}'; DELETE FROM business_monthly_customer_sales; DELETE FROM debt_cycle_runs;");
    const unchanged=await f.service.readBoard({month:'2026-10'});
    assert.deepEqual(unchanged.rows,closed.rows);assert.deepEqual(unchanged.summary,closed.summary);
    assert.deepEqual(await f.service.finalizePendingMonths(),[]);
  } finally {await f.db.close();}
});

test('invalid, future and unavailable history months fail clearly instead of fabricating rewards',async()=>{
  const f=await setup();try {
    await assert.rejects(f.service.readBoard({month:'2026-13'}),e=>e.statusCode===400);
    await assert.rejects(f.service.readBoard({month:'2026-11'}),e=>e.statusCode===400);
    await assert.rejects(f.service.readBoard({month:'2026-09'}),e=>e.statusCode===404);
  } finally {await f.db.close();}
});

test('inactive customers contribute neither monthly points nor sealed penalties, even with stale snapshots',async()=>{
  const f=await setup();try {
    await f.owe('2026-10-14');
    await f.snapshot('2026-10-15'); f.repository.bumpVersion();
    await finalizePendingPenaltyCycles(f.pool,{repository:f.repository,log(){}});
    await f.service.readBoard(); // Warm both caches before the status changes.
    await f.db.exec(`UPDATE customers SET raw=raw || '{"isActive":false}'::jsonb WHERE branch='hanoi' AND id=1;
      UPDATE customers SET raw=raw || '{"IsActive":false}'::jsonb WHERE branch='saigon';
      INSERT INTO customers VALUES ('hanoi',99,'KH2','Inactive duplicate',0,'{"groups":"Wrong sale","isActive":false}');
      INSERT INTO invoices VALUES ('hanoi',999,'ORPHAN',999,'2026-10-10Z',9000000000,1,'{"customerCode":"UNKNOWN","statusValue":"Hoàn thành"}');`);
    f.service.clearScores(); f.repository.bumpVersion();
    const board=await f.service.readBoard();
    assert.equal(board.rows.length,1);
    assert.equal(board.rows[0].sale,'An');
    assert.equal(board.rows[0].points,25);
    assert.equal(board.rows[0].scoreCustomers.length,5);
    assert.equal(board.rows[0].customerCount,5);
    assert.equal(board.rows[0].grossPenalty,0);
    assert.equal(board.summary.allocatedReward,0);
    assert.deepEqual(board.days,[]);
    assert.equal((await f.db.query('SELECT COUNT(*)::int n FROM debt_penalty_daily')).rows[0].n,1);
  } finally {await f.db.close();}
});

test('customer reassignment refreshes points and moves the open-cycle live penalty to the new sale',async()=>{
  const f=await setup();try {
    await f.owe('2026-10-14');
    assert.equal((await f.service.readBoard()).rows.find(r=>r.sale==='An').grossPenalty,25000);
    await f.db.exec(`UPDATE customers SET raw='{"groups":"Chi"}' WHERE branch='hanoi'`);
    f.setNow('2026-10-14T09:01:01Z');
    const board=await f.service.readBoard();
    assert.equal(board.rows.find(r=>r.sale==='Chi').points,30);
    assert.equal(board.rows.find(r=>r.sale==='Chi').grossPenalty,25000);
    assert.equal(board.rows.some(r=>r.sale==='An'),false);
  } finally {await f.db.close();}
});

test('a serialization conflict during monthly insert retries with a fresh transaction',async()=>{
  const f=await setup();try {
    await f.snapshot('2026-10-31'); f.repository.bumpVersion();
    await finalizePendingPenaltyCycles(f.pool,{repository:f.repository,log(){}});
    await f.snapshot('2026-11-01'); f.repository.bumpVersion(); f.setNow('2026-11-01T08:01:00Z');
    await finalizePendingPenaltyCycles(f.pool,{repository:f.repository,log(){}});
    await f.pool.query(businessSql.FREEZE_CUSTOMER_SQL,[['hanoi','saigon'],'2026-10-01','2026-11-01']);
    await f.db.exec("INSERT INTO business_monthly_state(month) VALUES ('2026-10-01')");
    const connect=f.pool.connect;let conflicts=0;
    f.pool.connect=async()=>{const client=await connect();return {...client,query:async(s,p)=>{
      if(s.includes('INSERT INTO debt_reward_months')&&!conflicts++)throw Object.assign(Error('concurrent close'),{code:'40001'});
      return client.query(s,p);
    }};};
    let notices=0;
    assert.deepEqual(await f.service.finalizePendingMonths({onClosed:()=>notices++}),['2026-10']);
    assert.equal(notices,1);
    assert.deepEqual(await f.service.finalizePendingMonths(),[]);
    assert.equal((await f.db.query('SELECT COUNT(*)::int AS count FROM debt_reward_months')).rows[0].count,1);
  } finally {await f.db.close();}
});

test('sealed penalties count a same-name customer once per day using the higher branch amount',async()=>{
  const f=await setup();try {
    const customers=[['hanoi',101,'KX1','Nguyễn Văn X'],['saigon',201,'KY1','nguyễn  văn x '],
      ['hanoi',102,'KX2','Trần B'],['saigon',202,'KY2','Lê C'],
      ['hanoi',103,'KX3','Dup'],['hanoi',104,'KX4','Dup'],['saigon',203,'KY3','dup'],
      ['hanoi',105,'KX5',''],['saigon',205,'KY5','']];
    for (const [branch,id,code,name] of customers) await f.db.query('INSERT INTO customers VALUES ($1,$2,$3,$4,0,$5)',[branch,id,code,name,JSON.stringify({groups:'An'})]);
    const rows=[['2026-10-01','hanoi',101,'Nguyễn Văn X',90000],['2026-10-01','saigon',201,'nguyễn  văn x ',120000],
      ['2026-10-02','hanoi',101,'Nguyễn Văn X',50000],['2026-10-02','saigon',201,'nguyễn  văn x ',50000],
      ['2026-10-03','hanoi',101,'Nguyễn Văn X',70000],
      ['2026-10-04','hanoi',102,'Trần B',40000],['2026-10-04','saigon',202,'Lê C',25000],
      ['2026-10-05','hanoi',103,'Dup',10000],['2026-10-05','hanoi',104,'Dup',10000],['2026-10-05','saigon',203,'dup',15000],
      ['2026-10-06','hanoi',105,'',10000],['2026-10-06','saigon',205,'',10000]];
    for (const [date,branch,id,name,amount] of rows) await f.db.query(
      "INSERT INTO debt_penalty_daily(cycle_date,branch,customer_id,sale,customer_name,amount) VALUES ($1,$2,$3,'An',$4,$5)",[date,branch,id,name,amount]);
    for (const date of ['2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-05','2026-10-06']) await f.db.query('INSERT INTO debt_penalty_cycles(cycle_date) VALUES ($1)',[date]);
    const an=(await f.service.readBoard()).rows.find(r=>r.sale==='An');
    const byDay=Object.fromEntries(an.days.map(d=>[d.cycleDate,d]));
    assert.deepEqual([byDay['2026-10-01'].amount,byDay['2026-10-01'].customers],[120000,1]);
    assert.deepEqual([byDay['2026-10-02'].amount,byDay['2026-10-02'].customers],[50000,1]);
    assert.deepEqual([byDay['2026-10-03'].amount,byDay['2026-10-03'].customers],[70000,1]);
    assert.deepEqual([byDay['2026-10-04'].amount,byDay['2026-10-04'].customers],[65000,2]);
    assert.deepEqual([byDay['2026-10-05'].amount,byDay['2026-10-05'].customers],[20000,2]);
    assert.deepEqual([byDay['2026-10-06'].amount,byDay['2026-10-06'].customers],[20000,2]);
    assert.equal(an.grossPenalty,345000);assert.equal(an.penaltyDays,6);assert.equal(an.lastDayCustomers,2);
    assert.equal(an.days.reduce((sum,d)=>sum+d.amount,0),an.grossPenalty);
    const board=await f.service.readBoard();
    assert.equal(board.days.find(d=>d.cycleDate==='2026-10-02').branch,'hanoi');
    assert.equal(board.summary.grossPenalty,345000);
  } finally {await f.db.close();}
});


test('reward reads current sale teams even when monthly results are finalized', async () => {
  const f = await setup();
  try {
    await f.db.exec("CREATE TABLE sale_teams (sale_name text, team_name text); INSERT INTO sale_teams VALUES ('An', 'Team A')");
    const board = await f.service.readBoard();
    assert.equal(board.rows.find(r => r.sale === 'An').saleTeam, 'Team A');
    // Bảng tạm tính đang được giữ ngắn hạn vẫn phải hiện team mới ngay.
    await f.db.exec("UPDATE sale_teams SET team_name = 'Team C'");
    assert.equal((await f.service.readBoard()).rows.find(r => r.sale === 'An').saleTeam, 'Team C');
    await f.db.query("INSERT INTO debt_reward_months(month, rule_version, finalized_at, result) VALUES ('2026-10-01', 'test', now(), $1::jsonb)", [JSON.stringify(board)]);
    // Ghi thẳng thay cho finalizeMonth: luồng thật xóa bảng đang giữ khi chốt tháng xong.
    f.service.clearScores();
    await f.db.exec("UPDATE sale_teams SET team_name = 'Team B'");
    const changed = await f.service.readBoard();
    assert.equal(changed.status, 'finalized');
    assert.equal(changed.rows.find(r => r.sale === 'An').saleTeam, 'Team B');
    assert.equal(changed.rows.find(r => r.sale === 'An').reward, board.rows.find(r => r.sale === 'An').reward);
  } finally { await f.db.close(); }
});

// /penalty-board: nhiều người mở cùng lúc chỉ tính 1 lần; giữ 30 s khi công nợ không đổi; ghi công nợ / quá hạn / lỗi thì tính lại.
test('penalty board is computed once for concurrent readers, kept briefly and recomputed after changes or errors', async () => {
  const f = await setup();
  try {
    let computes = 0, failNext = false;
    const pool = { query: async (sql, params) => {
      if (/FROM debt_reward_months ORDER BY month DESC/.test(sql)) {
        computes++;
        if (failNext) { failNext = false; throw new Error('db down'); }
      }
      return f.pool.query(sql, params);
    }, connect: f.pool.connect };
    let instant = new Date('2026-10-14T09:00:00Z');
    const service = createDebtRewardService({ pool, repository: f.repository, now: () => instant });
    const [hn, sg, both] = await Promise.all([
      service.readBoard({ branches: ['hanoi'] }), service.readBoard({ branches: ['saigon'] }), service.readBoard()
    ]);
    assert.equal(computes, 1, 'concurrent readers share one computation');
    assert.ok(hn.rows.every(r => r.branches.includes('hanoi')) && sg.rows.every(r => r.branches.includes('saigon')));
    assert.equal(both.rows.length, new Set([...hn.rows, ...sg.rows].map(r => r.sale)).size);
    await service.readBoard();
    assert.equal(computes, 1, 'kept while debt data is unchanged');
    f.repository.bumpVersion();
    await service.readBoard();
    assert.equal(computes, 2, 'a debt write invalidates the kept board');
    instant = new Date(instant.getTime() + 31000);
    await service.readBoard();
    assert.equal(computes, 3, 'expires after 30 s');
    f.repository.bumpVersion();
    failNext = true;
    await assert.rejects(service.readBoard(), /db down/);
    await service.readBoard();
    assert.equal(computes, 5, 'a failed computation is not kept');
  } finally { await f.db.close(); }
});

test('a debt write during the board computation is not hidden by the kept board', async () => {
  const f = await setup();
  try {
    let computes = 0, writeDuring = true;
    const pool = { query: async (sql, params) => {
      if (/FROM debt_reward_months ORDER BY month DESC/.test(sql)) {
        computes++;
        if (writeDuring) { writeDuring = false; f.repository.bumpVersion(); } // ghi công nợ xen giữa lúc đang tính
      }
      return f.pool.query(sql, params);
    }, connect: f.pool.connect };
    const service = createDebtRewardService({ pool, repository: f.repository, now: () => new Date('2026-10-14T09:00:00Z') });
    await service.readBoard();
    await service.readBoard();
    assert.equal(computes, 2, 'board computed before the write must not be kept');
    await service.readBoard();
    assert.equal(computes, 2);
  } finally { await f.db.close(); }
});
