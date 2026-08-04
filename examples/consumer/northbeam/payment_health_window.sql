-- On-call check: average payment success rate per provider.
-- Reads analytics.marts.payment_health_daily. This file is the drill's
-- control: nothing here touches the renamed column, so it must stay green
-- through the break with an unchanged result hash.
SELECT provider,
       ROUND(AVG(success_rate), 4) AS avg_success_rate,
       COUNT(*) AS days_observed
FROM payment_health_daily
GROUP BY provider
ORDER BY provider;
