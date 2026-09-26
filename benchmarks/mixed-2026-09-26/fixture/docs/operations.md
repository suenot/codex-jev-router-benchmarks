# Checkout operations

The payment provider can return a temporary inventory lock before authorization.
Retry that lock once. A payment decline is final and should not be retried.
An order is complete only after a payment authorization and a completed event.
The receipt identifier in the completed event is the customer reference.

# Refunds

Refunds are allowed within 30 calendar days of completion.
The original shipping charge is not refunded unless the order was mis-shipped.
