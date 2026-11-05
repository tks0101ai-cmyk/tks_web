-- 0103: lich su "bo dong chi dinh" (order_pick_history action 'prune'). Khi ma hang bi xoa khoi don Kiot (nut "Xoa dong" hoac
-- sua thang tren Kiot), dong chi dinh cua ma do trong luot 'picking' bi bo de tra giu cho vi tri (truoc day dong nay an trong hop
-- chi dinh nhung van chan xoa dong VT). summary: { reason: 'line_removed' | 'kiot_line_missing', lines: [...] }.
-- Khong them cot/bang; chi mo rong CHECK cua action. Code fail-soft khi chua ap (van bo dong, chi khong ghi lich su).
ALTER TABLE order_pick_history DROP CONSTRAINT IF EXISTS order_pick_history_action_check;
ALTER TABLE order_pick_history ADD CONSTRAINT order_pick_history_action_check
  CHECK (action IN ('assign', 'confirm', 'cancel', 'mismatch_ack', 'prune'));
