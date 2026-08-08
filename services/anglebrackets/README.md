# bullmoose-anglebrackets

The DAV face — **CardDAV + CalDAV over the same contacts/calendar core**,
so Apple Contacts/Calendar sync against exactly what the JMAP clients and
agents read. Public at `https://dav.bullmoose.cc` (Workers custom domain).

A **stateless** worker: no sessions, no locks — ETags and the sync-token
carry all state, which lives in the core (D1 + the `AccountDO` changelog,
bound cross-script from the jmap worker).

## Surface

- `GET /.well-known/carddav` · `/.well-known/caldav` → 301 `/dav/`
  (RFC 6764 discovery)
- `OPTIONS`, `PROPFIND`, `REPORT` (sync-collection, addressbook-multiget /
  addressbook-query, calendar-multiget / calendar-query),
  `GET`/`PUT`/`DELETE` with ETags
- **Collections are read-write too**: `MKCALENDAR` (RFC 4791 §5.3.1) and
  extended `MKCOL` with an `addressbook` resourcetype (RFC 6352 §5.2 /
  RFC 5689), plus `DELETE` on a collection. So `File → New Calendar` in
  Apple Calendar works — the client picks the URI and that id **is** the
  collection id, since collections have no `dav_name` column. Structural
  writes are owner-only and refuse the default collection on delete.
- Deliberately **barely-conforming** (locked decision): the verb subset
  real clients actually use. `LOCK`/`UNLOCK`, `COPY`/`MOVE`, and ACLs are
  intentionally absent.

## Why it's cheap

Native clients **poll**. An idle poll is one PROPFIND reading the
collection `ctag` — O(1); only a changed ctag triggers a sync-collection
`REPORT`, which reads O(delta) from the DO changelog. That's what keeps a
household of devices inside the free-tier envelope
([`capacity-and-scaling.md`](../../docs/architecture/capacity-and-scaling.md)).

- **Contacts** — serves vCard 3.0 (what Apple speaks) from `card_json` via
  [`@bullmoose/contacts-core`](../../packages/contacts-core/README.md);
  photos live in R2 and are re-embedded only at serialize time.
- **Calendar** — serves iCalendar via
  [`@bullmoose/calendar-core`](../../packages/calendar-core/README.md), with
  fast-forward recurrence expansion + a cached VTIMEZONE to fit the 10ms
  CPU cap.

Auth is the same **app-password Basic** (user = login email, password =
`bm_…` token) the jmap worker and popcorn accept, and grants resolve
identically — a shared book/calendar appears in the sharee's home-set
automatically. Bindings: `DB` (D1), `BLOBS` (R2), `ACCOUNT_DO`
(cross-script from `bullmoose-jmap`). Device setup:
[`docs/carddav-setup.md`](../../docs/carddav-setup.md).
