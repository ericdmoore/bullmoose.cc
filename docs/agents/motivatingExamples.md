Motivating Examples
=================

Goal: Raise the "Signal to Noise" Ratio for humans. 
Ideally less but better emails to deal with.


- _All_Agents_:
    - Require:
        - AI Inference Capability
        - A Token Budget ($USD) / Time Window
            - potentially a 'pooled budget'
            - 


- _editor@_ (responder only)
    - an email workflow app
    - Need to bounce an idea off another writer - Emily is built just for that
    - Requires
        - basically nothing
        

- _analyst@_ (responder only)
    - Requires
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


- _news@_ (Workflow - discussion of interested news topics - gets )
    - Requires access to:
        - crawl4AI
        - feed.works?


- _bouncer@_
    - Can answer questions about the Email Sieve State
    - Requires access to:
        - Read All Human Account Email
        - Read/Write/Execute Sieve scripts
        - see: https://gist.github.com/Hotrod369/6b7a24e1ea060e48e0c02459cbb950a0

_photos@_ (responder only)
    - Multi Usage:
        - Photo Archivist
        - Sharing 
            - Is there somethhing to leverage?
            - pixelfed?
        - Share good pictures to include in daily report
            - good pics (meaning not-screenshots, not reciepts, )
    - Required
        - [] - can wait to recieve
    - Optoinal
        - Read All Human Account Email
            - scans for attachments and files            


- _newsletters@_
    - Proposed Usage Flow Opt1: 
        - Forward a newsletter to newsletters@ 
        - from then on I never see that newsletter again
        - I can ask for it to be included in the daily-look-ahead
        - I could ask if about coupons, or other stuff possibly in a newsletter
        -  but still get them - and I can ask about them
    - Requires access to:
        - Full Text Search

- _cal@_
    - Calvin will look at my next week calendar
    - Calvin will think through tight spots in the calendar - and prpose around 7 days early 
    - Highlight issue - and maybe even propose solutions - for how to get kids to all the places with limited number of drivers
    - Required access:
        - Calendar
        - Start Email Threads
        - Responds to CJ

- _docs@_
    - Doc keeps track of warranties, contracts, statements, 

- _schedule@_ (alias sydney@)
    - scheduling assistant
    - proposes times to external accounts

- _unsub@_
    - fwd emails to here and assume you will never see the sender again
    - 

- _travel@_
    - 

- _packages@_
    - 

- _help@_ 
    - answers questions about your own bullmoose 
        - "which agents can read my contacts?"
        - "why did editor@ skip that email?"
        - Self-referential, and it's the conversational face of the s03.E console.
    - Requires:
        - Github, docs, WebFetch
        - Email
        - Calendar
        - Contacts
        - Files
    

- _followups@_
    - Requires access to:
        - ReadAccess on Entire human account
        - drafts a thread for a human account - creates 


- _dailyReport@_ {{alias `cj@`}}  (think show: west-wing character chief of staff)
    - Requires access to:
        - Entire human Account
            - Email
            - Calendar
            - Contacts
            - Files
        - Asks other agents if they have anything intersting an time-bound for the next 48hrs
        - Collects Responses


---