Public Calendar Booking
======================


> **Status: raw notes, not started (2026-08-13).** No code — no free/busy surface, no `corey@`. Sibling note: `.backlog/bookings.md`.

@ref: See "Notion Calendar" where the public sees some set of your calenar 
- that "set" might be somewhere in-between the `empty-set`, and the `universal-set`
- pending on the humans privacy preferences and nature of their business.
- NotionCalendar usually shows free/busy only during business hours.
- We could also add some max future time. only allow scheduling up to "3 months" in advance.


Surfaces:
- API (to enable HTML over HTTP)
- and then agent "Corey@" (as in Corey Booker) emails the person right after booked online.

Worflow is configured by event-type within in a calednar:
- The Event-Type has rules for the workflow
- min max time-block time. Price per minute, any setup/teardown time between bookings.

Corey@ runs the worflow setup for the calendar
- Most workflows are "Collect Payment", "Collect Info" and to keep Corey from having to process too much untrusted-text - the user submits info via forms. and if the user replies with text - then all corey is alowed to do is to fill out the form - and send back the form with boxes with editable values already set.
- Some worflows might set small non-refundable reserve-fee + then lions-share payment is due at the time of - perhasp with an option for 5% discount for non-refundable pre-pay.
- As in if the person is booking time for a personal trainer the person might have to pre-pay online before securing the time-slot.
- The API (and thus Web) would show "a 3 min hold"(configurable) for requested time-blocks for person mid-process of reserving the time-block