-- Commercial model: revenue net of delivery by customer class.
-- The source column cost_of_delivery is what the repair drill renames.
select
    customer_class,
    sum(order_total) as total_revenue,
    sum(cost_of_delivery) as delivery_cost,
    sum(order_total) - sum(cost_of_delivery) as net_revenue
from {{ source('analytics', 'order_details') }}
group by customer_class
order by customer_class
