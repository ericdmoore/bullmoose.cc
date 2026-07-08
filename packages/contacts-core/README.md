# @bullmoose/contacts-core

vCard ⇄ JSContact translation: the codec under the contacts surface.
Parses vCard (RFC 6350, plus 3.0/2.1 compat) into [JSContact](https://datatracker.ietf.org/doc/html/rfc9553)
Cards and serializes back, following the [RFC 9555](https://datatracker.ietf.org/doc/html/rfc9555)
mapping. WebCrypto/worker-safe — no Node `Buffer`.

- **parse** — content-line lexing (unfold, quoted-printable, escaping) →
  JSContact `Card`. The proven direction: it drove the 4,120-card
  production import.
- **serialize** — `Card` → vCard 3.0 (what Apple Contacts speaks), which
  `services/anglebrackets` serves over CardDAV from `card_json`.
- **lossless** — properties with no JSContact home ride in the RFC 9555
  `vCardProps` extension (jCard-shaped) and are re-emitted verbatim.

A `Card` is treated as an open object (`Record<string, unknown>`) — the
store owns the schema; this package owns the wire translation. Used by
`services/anglebrackets` (CardDAV) and the CLI's `contacts import`. Design:
[`docs/architecture/capability-roadmap.md`](../../docs/architecture/capability-roadmap.md).
