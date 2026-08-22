# s39 — avatars, in two rungs

A face beside a name, for the account chip and for every correspondent in a
list. Two rungs, and the second one covers almost everyone.

**1 — did they choose one?** Stored per user, editable in settings, synced so
the CLI and every device agree. Real state, and the only rung that needs to
know who is signed in.

**2 — derive it from the address.** Deterministic, local, no network.

That is the whole ladder. What follows is why each of the tempting extra
pieces is absent, because each was considered and each has a specific reason.

---

## No gravatar

It is the obvious rung 2 and it contradicts the product.

`sanitize.ts`, on mail: *"Remote content is blocked BY DEFAULT (tracking
pixels)."* A gravatar request is exactly that — it tells Automattic that this
browser loaded a page concerning `md5(someone@example.com)`, with a timestamp.

And avatars are not only yours. They render for CORRESPONDENTS, so every
message opened and every contact scrolled past would disclose who you
correspond with to a third party. A tracking pixel arriving through the front
door of a product that blocks them at the back.

If someone wants their own face published to a third party that is their call
to make — an explicit opt-in, never for correspondents, and not in V1.

## No md5

md5 was only ever there to be gravatar-compatible, and gravatar is gone.

It is also not free: **WebCrypto has no md5.** SHA-1/256/384/512 and nothing
else, and there is no md5 anywhere in this codebase. Using it means shipping
an implementation to hash a string we already hold, for a seed that never
leaves the browser.

So the seed is the address itself. `avatar(config, "coach@example.com")` is as
deterministic and as well distributed as its hash.

*If* a seed ever becomes durable — a cache key, a URL, an IndexedDB record —
hash it then, with SHA-256, which is native. That has a real reason behind it
(keeping raw addresses out of storage and logs) rather than an inherited one.

## Derived on the CLIENT, not the server

"Server-side" has no server to run on: the webmail is **static output** to
Cloudflare Pages (`astro.config.mjs`: *"Static output (Cloudflare Pages, the
same proven path…)"*). There is no per-request render, so server generation
means a Worker endpoint, and that costs two things worth more than it saves:

- **it breaks offline.** s35 put message bodies in IndexedDB precisely so a
  re-read paints without the network. Avatars behind a round trip mean a
  cached message renders with holes where the faces go.
- **it is a request per face.** A contact list is thirty of them — thirty
  requests to draw something computable from a string already in hand.

Deriving locally has no request, no latency, nothing to cache-bust, and works
for all thirty at once.

Note the asymmetry this creates, which is the useful part: **rung 2 needs no
identity at all.** It works for anyone whose address is already on screen.
Only rung 1 depends on knowing who is signed in — the same thing the account
chip is waiting on, and the same reason the shell is `client:only` and flashes
on every realm change. Fixing identity fixes both; until then, rung 2 covers
every face except the reader's own.

## The generator is an open, measurable question

dicebear is not a dependency today. Adding it is a genuine buy: real variety,
a maintained aesthetic, and a bundle cost nobody has measured. The alternative
is a hash and a handful of SVG shapes.

The repo has made this trade before and written it down — *"NOT TAKEN
@heroicons/react. Nine static SVG paths are inlined instead of adding a
dependency to ship them."* That is a bias, not a rule. **Measure it and let
the number decide**, and record the number here either way.

One constraint whichever wins: a per-user gradient cannot be an inline
`style`, because the generated CSP carries no `'unsafe-inline'` for styles.
Inline SVG with `fill` ATTRIBUTES is fine and is what the app already does for
every icon.

## The placeholder, while rung 1 loads

A neutral shape, not a wrong one. A blank circle becoming your avatar reads as
loading; a green blob becoming a purple one reads as a bug. Same line s35 drew
for skeletons: stand where the content goes, and claim nothing.
