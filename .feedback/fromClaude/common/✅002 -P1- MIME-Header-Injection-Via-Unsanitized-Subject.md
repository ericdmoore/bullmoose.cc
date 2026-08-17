# 002 -P1- MIME header injection via unsanitized subject

**Subsystem:** common (`packages/mime`) · **Severity:** HIGH (security) · **Fix class:** CHANGE-CODE

## The defect

`packages/mime/src/index.ts:112-114` returns a header value verbatim when it is ASCII, and
`isAscii` (`:120-123`) tests `/^[\x00-\x7F]*$/` — **CR and LF are ASCII and pass through**. Line 45
interpolates the result into `Subject: …`; line 74 joins all headers with CRLF.

So a value containing `\r\n` injects arbitrary additional headers — or, with a blank line, a
forged body.

Same shape in two more places:

- `formatAddress` (`:101-109`) interpolates `a.email` unescaped.
- `extraHeaders` (`:46`) is verbatim by design.

## Reachability from untrusted input

`packages/account-do/src/index.ts:181` builds the vacation auto-response subject as
`` `Auto: Re: ${p.origSubject}` ``, where `origSubject` is the **raw inbound subject**
(`services/ingest/src/index.ts:214` → `:276`).

An RFC 2047 encoded-word decodes to arbitrary text **including CRLF**, so a remote sender controls
the value. Precondition: the target account has an enabled vacation responder — which narrows the
window but does not close it.

## Duplicate to fix at the same time

`packages/cli/src/mime.ts:166` has the same construction. Fix both, or fold them into one shared
builder.

## Doc gap

`packages/mime/README.md:13` describes header protection as only "RFC 2047 B-encoding for non-ASCII
headers" — charset handling. No injection concern is stated anywhere, so the omission reads as
"handled" rather than "not considered".
