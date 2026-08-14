---
ref:
    - https://www.mindstudio.ai/models
    
---


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


- _peter@_ (supports multiple workflows - respond-only, observe-and-propose)
    - Peter tries to understand your business, takes notes about your various initiatives, themes of work going on, 
    - Peter can look across the web for:
        - segments & prospects
        - vendor & partner companies
        - ...then draft up proposed emails to send these researched groups
            - noting their buyer behavior, problems-to-solve, willingness-to-pay, etc


- _bouncer@_
    - Can answer questions about the Email Sieve State
    - Requires access to:
        - Read All Human Account Email
        - Read/Write/Execute Sieve scripts
        - see: https://gist.github.com/Hotrod369/6b7a24e1ea060e48e0c02459cbb950a0


_photos@_ (supports multiple workflows)
    - Multiple Uses:
        - Photo Archivist - think Google Photo backups (gets much better with ios app)
        - Make a Named Shared Folders
            - Co-Owned Fodlers (basically permanent)
            - Shared Folder (Long Term)
                - Think Very long-term (almost permanent)
            - Event Folder
                - think: school-event, football game, prom-dance, etc
                - optionally with:
                    - end date
                        - send out summaries daily until end
                        - sends out final compilation folder
            - Inviting email addresses
                - just CC them when starting a new Event Fodler
                - those people email in their images to the hosted service
            - My `photos@alice` joining your `photos@bob`
                - Downloads Copies whole image - folder to my account 
        - Social Imaging Apps?
            - Could some folder of mine be syndicated out to 
                - pixelfed?
                - bluesky?
                - or some other image service?
        - Share good pictures to include in daily report
            - good pics (meaning not-screenshots, not reciepts, )
    - Required:
        - []; it can just wait to recieve messages
    - Optional:
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

# More candidates

Grouped by what they're *for*. Each is listed with the access it needs — several reveal
capability classes the list above doesn't exercise yet (called out in **What this reveals**
at the end).

## Noise reduction — the stated goal

- _screener@_ (gate on first contact — HEY's "Screener")
    - Nobody unknown reaches the inbox until you approve them once
    - Requires
        - ReadAccess: inbound before delivery
        - WriteAccess: move/hold (a quarantine mailbox)
        - a persistent sender verdict list (approved / denied)
    - Note: overlaps _bouncer@_ — RESOLVED: same agent. bouncer@ is now the fourth
      agent kind, specced in `.plans/s12-boundary/` (screening = the unknown-sender path)

- _unsubscribe@_ (forward junk, never see it again)
    - Finds `List-Unsubscribe` / RFC 8058 one-click and executes it, then confirms
    - Requires
        - ReadAccess: the forwarded message
        - **Egress**: HTTP POST to the unsubscribe endpoint (uncredentialed)
        - **Send**: for the `mailto:` unsubscribe variant ← *actually sends mail*
    - The canonical approval-queue item, and the cheapest one to graduate to auto

- _recruiter@_ (polite auto-decline)
    - Requires
        - ReadAccess: humanEmail
        - Draft or Send, per your taste
    - Low cost, high daily value for a lot of people

## Extraction — turn mail into structured data

- _travel@_ (itinerary builder)
    - Parses flight/hotel/car confirmations into one trip; puts it on the calendar
    - Requires
        - ReadAccess: humanEmail
        - WriteAccess: Calendar
        - optionally: airline/hotel APIs for status changes ← credentialed egress
    - This is TripIt's entire product

- _documents@_ (warranties, contracts, statements)
    - Files the PDF, extracts vendor / amount / expiry, sets a reminder before it lapses
    - Requires
        - **WriteAccess: Files** ← a strong motivator for the Files realm
        - WriteAccess: Calendar (the expiry reminder)
        - ledger-ish structured store

- _bills@_ (due-date tracking)
    - Requires
        - A-Ledger-Resource
        - WriteAccess: Calendar
        - overlaps _receipts@_ — receipts is *past* spend, bills is *future* obligation

## Watching — things that change after the email arrives

- _tracking@_ (packages)
    - Requires
        - ReadAccess: shipping confirmations
        - carrier APIs ← **credentialed egress**
        - **a scheduler** — the interesting bit: it must run *after* delivery, repeatedly

- _price@_ (watch a thing until it drops)
    - Requires
        - Egress (uncredentialed WebFetch)
        - persistent state per watch
        - **a scheduler**

## Outbound — the sharp end

- _schedule@_ (negotiate a meeting time over email)
    - The classic "AI assistant" case (x.ai / Amy). Also the sharpest test of `draft ≠ send`
    - Requires
        - ReadAccess + WriteAccess: Calendar
        - ReadAccess: Contacts
        - **Send** — it converses with a third party on your behalf
    - Every reply is tier-3 irreversible; this one probably never graduates to auto

- _intro@_ (double-opt-in introductions)
    - Requires
        - ReadAccess: Contacts
        - Send
    - The double-opt-in *is* an approval-queue flow, expressed as email

## Identity & privacy

- _aliases@_ (per-service masked addresses — Fastmail masked email / SimpleLogin)
    - A fresh address per signup; when one leaks you know exactly who sold it
    - Requires
        - **address provisioning** — write to the routes table ← *a new capability class*;
          no other agent here creates identities
        - ReadAccess: delivery metadata (which alias, which sender)
    - Leak detection is the `demo-keys` pattern generalized (auto-revoke when an address
      is used by senders it was never given to)

## Memory

- _archivist@_ (ask your own history)
    - "What did I agree with Dana about the deck?" · "When did we last talk about pricing?"
    - Requires
        - ReadAccess: entire human account
        - Full Text Search / semantic index (`ai-search-rag.md`)
    - The read-only twin of _cj@_: cj is time-bound and forward, archivist is unbounded
      and backward

## Household / family

- _school@_ (parse school comms)
    - Events → calendar, permission slips → **something needing a human signature**
    - Requires
        - ReadAccess: humanEmail
        - WriteAccess: Calendar, Files
        - an approval surface — the output is "you need to act", not a reply

## Meta

- _help@_ (answers questions about *your own* bullmoose)
    - "Which agents can read my contacts?" · "Why did editor@ skip that email?"
    - Requires
        - ReadAccess: agent bindings, grants, invocation history
    - Self-documenting, and it's the natural conversational face of the s03.E console

---

## What this reveals

Three capability axes the earlier list doesn't make explicit:

1. **Trigger type.** Most agents above are *on-delivery*. But _cj@_ is **scheduled**,
   _tracking@_ and _price@_ are **recurring**, and _archivist@_/_help@_ are **on-demand
   (ask)**. That's a per-binding property we don't model yet — today the only trigger is
   mailbox delivery + a cron sweep.

2. **Send posture, stated per agent.** Most are draft-only. But _unsubscribe@_,
   _schedule@_, and _intro@_ genuinely **send to third parties**, and _screener@_ **writes
   to your mailbox before you see it**. Those are the tier-3 / irreversible cases — worth
   marking on the binding rather than discovering at runtime.

3. **Two capability classes with no home yet:**
    - **Address provisioning** (_aliases@_) — creating identities, not just using them
    - **Scheduling** (_tracking@_, _price@_, _cj@_) — running on a clock, not on delivery

Also note the **privilege ladder** the whole list implies, which doubles as a build order:

```
editor@ (nothing) → recruiter@/unsubscribe@ (read + one action)
  → travel@/documents@ (write one realm) → screener@ (write before delivery)
  → schedule@ (send to third parties) → cj@ (whole account + agent-to-agent)
```

## Deliberately not

- _2fa@_ — extracting OTP codes would centralize the second factor into the thing that
  already receives the first. Attractive and wrong; the whole point of 2FA is that the
  channels are separate.