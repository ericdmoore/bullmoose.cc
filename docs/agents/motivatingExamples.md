Motivating Examples
=================

Goal: Raise the "Signal to Noise" Ratio for humans. 
Ideally less but better emails to deal with.

- _editor@_ (responder only)
    - an email workflow app
    - Need to bounce an idea off another writer - Emily is built just for that
    - Requires access to:
        - basically nothing

- _analyst@_ (responder only)
    - Requires access to:
        - A-Ledger-Resource 
            - some kind of ledger-resource
            - possibly some external compute
    - OptionalAccess
        - ReadAccess:humanEmail

- _receipts@_ (responder only)
    - Requires access to:
        - A-Ledger-Resource 
            - some kind of ledger-resource
            - possibly some external compute
    - OptionalAccess
        - ReadAccess:humanEmail

- _crm@_ (responder only)
    - Need to update a contact? ask about contacts?
    - Forward emails to crm@ and it will parse the email and look for interesting and permanent info to save 
    - Requires access to:
        - the CRM-system...
    - OptionalAccess
        - ReadAccess:humanEmail

- _reviews@_ (responder only)
    - Requires access to:
        - The broader internet?

- _reservation@_ (Workflow - start a reservation request - get approval-followups )
    - Requires access to:
        - opentable
        - HumanCalendar

- _news@_ (Workflow - discussion of interested news topics)
    - Requires access to:
        - crawl4AI
        - feed.works?

- _bouncer@_
    - Requires access to:
        - Whole Human Account

- _newsletters@_
    - Proposed Usage Flow Opt1: 
        - Forward a newsletter to newsletters@ 
        - from then on I never see that newsletter again
        - I can ask for it to be included in the daily-look-ahead
        - I could ask if about coupons, or other stuff possibly in a newsletter
        -  but still get them - and I can ask about them
    - Requires access to:
        - Full Text Search

- _followups@_
    - Requires access to:
        - ReadAccess on Entire human account
        - drafts a thread for a human account - creates 

- _dailyReport@_ alias `cj@` think show: west-wing character chief of staff
    - Requires access to:
        - Entire human Account
            - Email
            - Calendar
            - Contacts
            - Files
        - Asks other agents if they have anything intersting an time-bound for the next 48hrs
        - Collects Responses
