-- Ops check: order mix by status off the point-in-time history.
-- Reads order_history. This file is the drill's control: nothing here touches
-- the renamed column, so it must stay green through the break with an
-- unchanged result hash.
SELECT order_status,
       COUNT(*) AS orders,
       ROUND(SUM(order_total), 2) AS order_value
FROM order_history
GROUP BY order_status
ORDER BY order_status;
