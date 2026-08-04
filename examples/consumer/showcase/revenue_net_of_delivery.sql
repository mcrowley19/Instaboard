-- Commercial pack: revenue net of delivery, by customer class.
-- Reads order_details — cost_of_delivery is the column the repair drill
-- renames out from under this query.
SELECT customer_class,
       ROUND(SUM(order_total), 2) AS total_revenue,
       ROUND(SUM(cost_of_delivery), 2) AS delivery_cost,
       ROUND(SUM(order_total) - SUM(cost_of_delivery), 2) AS net_revenue
FROM order_details
GROUP BY customer_class
ORDER BY customer_class;
