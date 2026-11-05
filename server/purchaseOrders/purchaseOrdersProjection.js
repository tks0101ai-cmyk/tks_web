'use strict';
const { randomUUID } = require('node:crypto');
const expected = require('../productContainers/expectedRefresh').__test__;
const LABELS = { 1: '1.Chưa có lịch', 2: '2.Chưa bốc', 3: '3.Đã bốc', 4: '4.Đã về' };
async function projectContainers(client) {
  // Called inside the same locked transaction as canonical changes. Legacy
  // readers keep their contract and never write back into the canonical tables.
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
      CASE WHEN o.freight_prepaid IS NOT NULL AND o.freight_postpaid IS NOT NULL AND cost.freight IS NOT NULL AND o.fx_rate>0 AND o.qty_per_carton>0 AND o.carton_count>0
        THEN ((o.qty_per_carton*o.carton_count*o.unit_price_cny+o.freight_prepaid+o.freight_postpaid)*o.fx_rate+cost.freight)/NULLIF(o.qty_per_carton*o.carton_count,0)
        ELSE NULL END AS vietnam_price,
      o.unit_price_cny,COALESCE(o.buy_note,'') AS other_note
    FROM purchase_orders o LEFT JOIN product_containers c ON c.id=o.container_id
    LEFT JOIN (SELECT container_id,sum(carton_count*m3_per_carton) volume,bool_and(m3_per_carton>0 AND carton_count>0 AND m3_per_carton IS NOT NULL) complete FROM purchase_orders WHERE deleted_at IS NULL GROUP BY container_id) totals ON totals.container_id IS NOT DISTINCT FROM o.container_id
    LEFT JOIN LATERAL(SELECT CASE WHEN o.m3_per_carton>0 AND o.carton_count>0 THEN o.carton_count*o.m3_per_carton*CASE WHEN c.id IS NULL OR c.freight_mode='formula' THEN COALESCE(c.freight_base,202000000)/COALESCE(c.freight_capacity,170) WHEN totals.complete AND totals.volume>0 THEN c.freight/totals.volume ELSE NULL END ELSE NULL END AS freight) cost ON true
    WHERE o.deleted_at IS NULL`);
  const cols = ['sheet_name','sheet_order','container_row','source_row','product_code','product_key','container_name','status','status_label','eta','color','sale_note','ordered_by','listed_at','units_per_package','package_count','quantity','vietnam_price','unit_price_cny','other_note'];
  await client.query(`DELETE FROM product_container_lines l WHERE l.sheet_name<>'THU MUA' OR NOT EXISTS(SELECT 1 FROM purchase_line_projection s WHERE s.source_row=l.source_row)`);
  await client.query(`INSERT INTO product_container_lines(${cols.join(',')}) SELECT ${cols.join(',')} FROM purchase_line_projection
    ON CONFLICT(sheet_name,source_row) DO UPDATE SET ${cols.filter(c=>!['sheet_name','source_row'].includes(c)).map(c=>`${c}=EXCLUDED.${c}`).join(',')}
    WHERE (${cols.map(c=>'product_container_lines.'+c).join(',')}) IS DISTINCT FROM (${cols.map(c=>'EXCLUDED.'+c).join(',')})`);
  await client.query('UPDATE product_container_sync SET version=$1,last_success_at=now(),last_error=NULL WHERE singleton=true',[randomUUID()]);
  await client.query(expected.STAGE_SQL);
  await client.query(`DELETE FROM product_container_expected t WHERE NOT EXISTS(SELECT 1 FROM expected_stage s WHERE s.sheet_name=t.sheet_name AND s.source_row=t.source_row)`);
  await client.query(expected.UPSERT_SQL);
  await client.query(`UPDATE product_container_expected e SET product_name=o.product_name FROM purchase_orders o WHERE e.sheet_name='THU MUA' AND e.source_row=o.id AND e.product_name IS DISTINCT FROM o.product_name`);
  await client.query(expected.STATE_SQL,[true]);
}
module.exports = { projectContainers, LABELS };
