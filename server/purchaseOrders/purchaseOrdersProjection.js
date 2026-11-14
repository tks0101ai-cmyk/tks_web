'use strict';
const { randomUUID } = require('node:crypto');
const expected = require('../productContainers/expectedRefresh').__test__;
const freightModel = require('../public/shared/purchase-freight');
const LABELS = { 1: '1.Chưa có lịch', 2: '2.Chưa bốc', 3: '3.Đã bốc', 4: '4.Đã về' };
async function projectContainers(client) {
  // Called inside the same locked transaction as canonical changes. Legacy
  // readers keep their contract and never write back into the canonical tables.
  //
  // purchase_settings.projection_owns_all quyet dinh pham vi (xem migration 0115):
  //   false — so huu mot phan: chi thay the cont co trong product_containers,
  //           dong cua sheet khac giu nguyen, khong day hang cho xep sang.
  //   true  — so huu toan phan: Thu mua la nguon duy nhat.
  const containers=(await client.query('SELECT * FROM product_containers')).rows;
  const volumeRows=(await client.query('SELECT container_id AS "containerId",COALESCE(sum(carton_count*m3_per_carton),0)::numeric AS volume,COALESCE(bool_and(m3_per_carton>0 AND carton_count>0 AND m3_per_carton IS NOT NULL),false) AS complete FROM purchase_orders WHERE deleted_at IS NULL AND inactive_at IS NULL GROUP BY container_id')).rows;
  const stats=new Map(volumeRows.map(row=>[String(row.containerId??''),{volume:Number(row.volume),complete:row.complete}])),rates=new Map();
  for(const container of [{id:null,freightMode:'formula'},...containers]){const key=String(container.id??''),summary=stats.get(key)||{volume:0,complete:true},fee=freightModel.calculate(container,summary.volume),rate=fee.mode==='manual'&&(!summary.complete||!summary.volume||fee.amount==null)?null:fee.rate;if(container.freight_formula&&summary.volume>0&&rate==null)throw Object.assign(new Error(`Công thức cước cont ${container.name} cho kết quả không hợp lệ với tổng m³ hiện tại. Sửa công thức hoặc chuyển sang nhập số tiền.`),{statusCode:400,code:'FREIGHT_FORMULA_INVALID'});rates.set(key,rate)}
  await client.query('CREATE TEMP TABLE purchase_container_freight_rates(container_id BIGINT, rate NUMERIC) ON COMMIT DROP');
  for(const [containerId,rate] of rates)await client.query('INSERT INTO purchase_container_freight_rates(container_id,rate) VALUES($1,$2)',[containerId===''?null:containerId,rate]);
  const ownsAll = (await client.query('SELECT projection_owns_all FROM purchase_settings WHERE id=1')).rows[0]?.projection_owns_all === true;
  await client.query(`CREATE TEMP TABLE purchase_line_projection ON COMMIT DROP AS
    SELECT 'THU MUA'::text AS sheet_name, 0::integer AS sheet_order,
      COALESCE(c.id,0)::integer AS container_row,o.id::integer AS source_row,
      o.product_code,lower(btrim(o.product_code)) AS product_key,
      COALESCE(c.name,'CONT CHỜ XẾP') AS container_name,COALESCE(c.status,1)::smallint AS status,
      CASE COALESCE(c.status,1) WHEN 1 THEN '1.Chưa có lịch' WHEN 2 THEN '2.Chưa bốc' WHEN 3 THEN '3.Đã bốc' ELSE '4.Đã về' END AS status_label,
      COALESCE(c.arrival_date::text,NULLIF(c.arrival_note,''),'') AS eta,
      COALESCE(o.color,'') AS color,COALESCE(o.sale_note,'') AS sale_note,
      COALESCE(o.buyer,'') AS ordered_by,COALESCE(o.listed_at::text,'') AS listed_at,
      o.qty_per_carton AS units_per_package,o.carton_count AS package_count,
      o.qty_per_carton*o.carton_count AS quantity,
      CASE WHEN o.fx_rate>0 AND o.qty_per_carton>0 AND o.carton_count>0 AND o.unit_price_cny IS NOT NULL
        THEN ((o.qty_per_carton*o.carton_count*o.unit_price_cny+COALESCE(o.freight_prepaid,0))*o.fx_rate+COALESCE(cost.freight,0)+(o.qty_per_carton*o.carton_count*o.unit_price_cny*COALESCE(o.surcharge_percent,0)*o.fx_rate)+COALESCE(o.freight_postpaid,0)*3920)/NULLIF(o.qty_per_carton*o.carton_count,0)
        ELSE NULL END AS vietnam_price,
      o.unit_price_cny,COALESCE(o.buy_note,'') AS other_note
    FROM purchase_orders o LEFT JOIN product_containers c ON c.id=o.container_id
    LEFT JOIN purchase_container_freight_rates freight_rate ON freight_rate.container_id IS NOT DISTINCT FROM o.container_id
    LEFT JOIN LATERAL(SELECT CASE WHEN o.m3_per_carton>0 AND o.carton_count>0 THEN o.carton_count*o.m3_per_carton*freight_rate.rate ELSE NULL END AS freight) cost ON true
    WHERE o.deleted_at IS NULL AND o.inactive_at IS NULL${ownsAll ? '' : ' AND o.container_id IS NOT NULL'}`);
  const cols = ['sheet_name','sheet_order','container_row','source_row','product_code','product_key','container_name','status','status_label','eta','color','sale_note','ordered_by','listed_at','units_per_package','package_count','quantity','vietnam_price','unit_price_cny','other_note'];
  // Dong 'THU MUA' khong con trong ban chieu thi bo, o ca hai pham vi. Dong cua
  // sheet khac: toan phan thi xoa het; mot phan thi chi xoa cont ma Thu mua da
  // so huu — tranh de hai nguon cung mo ta mot cont.
  await client.query(`DELETE FROM product_container_lines l
    WHERE (l.sheet_name='THU MUA' AND NOT EXISTS(SELECT 1 FROM purchase_line_projection s WHERE s.source_row=l.source_row))
       OR (l.sheet_name<>'THU MUA' AND ${ownsAll ? 'true' : 'EXISTS(SELECT 1 FROM product_containers c WHERE c.name=l.container_name)'})`);
  await client.query(`INSERT INTO product_container_lines(${cols.join(',')}) SELECT ${cols.join(',')} FROM purchase_line_projection
    ON CONFLICT(sheet_name,source_row) DO UPDATE SET ${cols.filter(c=>!['sheet_name','source_row'].includes(c)).map(c=>`${c}=EXCLUDED.${c}`).join(',')}
    WHERE (${cols.map(c=>'product_container_lines.'+c).join(',')}) IS DISTINCT FROM (${cols.map(c=>'EXCLUDED.'+c).join(',')})`);
  await client.query('UPDATE product_container_sync SET version=$1,last_success_at=now(),last_error=NULL WHERE singleton=true',[randomUUID()]);
  await expected.stageExpected(client);
  await client.query(`DELETE FROM product_container_expected t WHERE NOT EXISTS(SELECT 1 FROM expected_stage s WHERE s.sheet_name=t.sheet_name AND s.source_row=t.source_row)`);
  await client.query(expected.UPSERT_SQL);
  await client.query(`UPDATE product_container_expected e SET product_name=o.product_name FROM purchase_orders o WHERE e.sheet_name='THU MUA' AND e.source_row=o.id AND e.product_name IS DISTINCT FROM o.product_name`);
  await client.query(expected.STATE_SQL,[true]);
}
module.exports = { projectContainers, LABELS };
