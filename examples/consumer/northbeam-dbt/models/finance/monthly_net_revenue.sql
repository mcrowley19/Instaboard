-- Finance close model: net revenue by month off the revenue fact.
-- The source column net_amount_usd is what the repair drill renames.
select
    date_trunc('month', revenue_date) as month,
    sum(net_amount_usd) as net_revenue,
    count(*) as payments
from {{ source('marts', 'fct_revenue') }}
group by 1
order by 1 desc
