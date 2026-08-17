# invoices@

## References

- Is this actually just `corey@`
  - corey is tied to calendar and time-booking, so if you have delivered a good or service instant maybe thats a new agent
    - perhaps we should draw the line that corey is for gating-delivery-of-goods-and-services
  - and lets say that that invoices@ is for reminding & nagging customers to pay their bills after goods and services are delivered
    - somethintg to help with net30 net90 billing
  - invoices@
    - is relentless in adding follow up mesages in the /approvals queue
    - with payment links

## Conversational Requirements

### Internal

- Might ask questions like:
  - How much $ is stting in AR (Accounts Receivable)
  - I would expect a response like:
    - "$XXX total is in AR, at a blended age of NN days, across 5 customers, oldest-outstanding is at XX, largest-outstanding at YY"
    - perhaps those segments might be `URLs or even just mailto: links` with preconfigured requests for visuals, charts, tabular data, etc on the various sections of number of customers outstanding, dollars, etc
  -

### EXTERNAL -

- invoices@ is the reply address on payment links requests. It does not reply directly but rather captures the reply and makes an proposal that awaits approval enqueue.
