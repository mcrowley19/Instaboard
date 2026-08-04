-- Refund drag: what refunds cost against gross, and the net share that survives.
-- Reads analytics.marts.fct_revenue on both gross_amount_usd and net_amount_usd.
SELECT ROUND(SUM(gross_amount_usd) - SUM(net_amount_usd), 2) AS refund_drag_usd,
       ROUND(SUM(net_amount_usd) / SUM(gross_amount_usd), 4) AS net_share
FROM fct_revenue;
