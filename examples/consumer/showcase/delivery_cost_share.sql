-- Margin watch: delivery cost as a share of order revenue.
-- Reads order_details on cost_of_delivery and order_total.
SELECT ROUND(SUM(cost_of_delivery) / SUM(order_total), 4) AS delivery_share
FROM order_details;
