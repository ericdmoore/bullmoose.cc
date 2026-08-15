import { describe, expect, it } from "vitest";
import { mintExploreCookie } from "./cookie";
import { TYPES, TYPE_NAMES } from "./types";
import {
  ALLEN,
  COOKIE_KEY,
  EMAIL_COUNT,
  ERIC,
  EXPLORE_HOST,
  ZED,
  harness,
  ids,
} from "./harness";

/**
 * s20 — the explorer, driven end to end through `worker.fetch`.
 *
 * Nothing is stubbed between the HTTP request and the JMAP method layer: the
 * fixture is real SQLite on the live schema and the real AccountDO, so a
 * projection that skipped `requireAccount`, or a `_links` href built from an id
 * nobody owns, fails here.
 *
 * The four assertions this file exists for:
 *
 *  1. **Isolation.** Every projected type refuses another account and another
 *     tenant, and no response for Eric contains a byte of anyone else's data.
 *  2. **Links resolve.** Every href the explorer emits is fetched, and an
 *     object link must return the object it claimed. A fabricated id 404s.
 *  3. **`_next` terminates.** Following it walks the collection once and stops.
 *  4. **No credential in any URL.** Every string in every response is scanned.
 */

// ---- what the explorer is ------------------------------------------------

describe("the grammar", () => {
  it("the index names the principal, the accounts and every listable collection", async () => {
    const h = await harness();
    const res = await h.explore("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    // Pretty-printed on purpose: a browser with no extension is a client too.
    expect(await res.clone().text()).toContain("\n  ");

    const body = await h.json<{
      _self: string;
      _meta: { principal: string; readOnly: boolean; types: string[] };
      accounts: Array<{ accountId: string; via: string; collections: Record<string, { href: string }> }>;
    }>(res);

    expect(body._self).toBe(`https://${EXPLORE_HOST}/`);
    expect(body._meta.principal).toBe("eric@bullmoose.cc");
    expect(body._meta.readOnly).toBe(true);
    expect(body._meta.types).toEqual([...TYPE_NAMES]);
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]).toMatchObject({ accountId: ERIC, via: "owned" });
    // Thread has no list projection, so the index must not offer one.
    expect(Object.keys(body.accounts[0]!.collections)).not.toContain("Thread");
    expect(Object.keys(body.accounts[0]!.collections)).toContain("Email");
  });

  it("GET /{Type}/{id} returns what JMAP returns, plus _self, _links and _meta", async () => {
    const h = await harness();
    const res = await h.explore(`/Email/${ids.email(ERIC, 1)}`);
    expect(res.status).toBe(200);
    const body = await h.json<Record<string, unknown>>(res);

    // "what JMAP returns" — the Email/get properties, unrenamed.
    expect(body.id).toBe(ids.email(ERIC, 1));
    expect(body.subject).toBe(`Subject 1 ${ERIC}`);
    expect(body.threadId).toBe(ids.thread(ERIC, 1));
    expect(body.mailboxIds).toEqual({ [ids.inbox(ERIC)]: true });
    expect(body.blobId).toBe(`blob_${ERIC}`);

    expect(body._self).toBe(
      `https://${EXPLORE_HOST}/Email/${ids.email(ERIC, 1)}?accountId=${ERIC}`,
    );
    expect(body._meta).toMatchObject({
      accountId: ERIC,
      type: "Email",
      methods: ["Email/get"],
      scopes: ["read"],
      domain: "mail",
    });
    expect(typeof (body._meta as Record<string, unknown>).state).toBe("string");
  });

  it("GET /{Type} pages through Type/query and hydrates through Type/get", async () => {
    const h = await harness();
    const body = await h.json<{
      _meta: { methods: string[]; position: number; limit: number; total: number; count: number };
      ids: string[];
      list: Array<Record<string, unknown>>;
    }>(await h.explore("/Email"));

    expect(body._meta.methods).toEqual(["Email/query", "Email/get"]);
    expect(body._meta.total).toBe(EMAIL_COUNT);
    expect(body._meta.count).toBe(EMAIL_COUNT);
    expect(body.ids).toHaveLength(EMAIL_COUNT);
    // Every item in a list is itself clickable — that is what makes the browser
    // the client.
    for (const item of body.list) {
      expect(typeof item._self).toBe("string");
      expect(item._links).toBeDefined();
    }
  });

  it("a type with no JMAP /query is served whole, and says so", async () => {
    const h = await harness();
    const body = await h.json<{ _meta: Record<string, unknown>; list: unknown[] }>(
      await h.explore("/AddressBook"),
    );
    expect(body._meta.methods).toEqual(["AddressBook/get"]);
    expect(body._meta.note).toContain("no AddressBook/query");
    expect(body._meta).not.toHaveProperty("position");
    expect(body.list).toHaveLength(1);
  });

  it("Thread has no list projection, and the refusal explains where to go instead", async () => {
    const h = await harness();
    const res = await h.explore("/Thread");
    expect(res.status).toBe(404);
    const body = await h.json<{ error: { type: string }; note: string }>(res);
    expect(body.error.type).toBe("notFound");
    expect(body.note).toContain("Thread/query");
    // But a Thread is reachable by id, which is the point of the note.
    const one = await h.explore(`/Thread/${ids.thread(ERIC, 1)}`);
    expect(one.status).toBe(200);
    expect((await h.json<{ emailIds: string[] }>(one)).emailIds).toHaveLength(2);
  });

  it("an unknown type 404s and lists what there is", async () => {
    const h = await harness();
    const res = await h.explore("/Widget");
    expect(res.status).toBe(404);
    expect((await h.json<{ types: string[] }>(res)).types).toEqual([...TYPE_NAMES]);
  });

  it("a missing object 404s with the JMAP type, not an empty 200", async () => {
    const h = await harness();
    const res = await h.explore("/Email/e_nope");
    expect(res.status).toBe(404);
    expect((await h.json<{ error: { type: string } }>(res)).error.type).toBe("notFound");
  });

  it("an unrecognised filter is refused rather than silently ignored", async () => {
    const h = await harness();
    const res = await h.explore("/ContactCard?inMailbox=mb_1");
    expect(res.status).toBe(400);
    const body = await h.json<{ error: { type: string }; accepts: string[] }>(res);
    expect(body.error.type).toBe("unsupportedFilter");
    expect(body.accepts).toContain("inAddressBook");
  });

  it("filters map 1:1 onto JMAP filter conditions", async () => {
    const h = await harness();
    const inInbox = await h.json<{ ids: string[] }>(
      await h.explore(`/Email?inMailbox=${ids.inbox(ERIC)}`),
    );
    expect(inInbox.ids).toHaveLength(EMAIL_COUNT);
    const inArchive = await h.json<{ ids: string[] }>(
      await h.explore(`/Email?inMailbox=${ids.archive(ERIC)}`),
    );
    expect(inArchive.ids).toHaveLength(0);

    // An empty value is the null parent — the top of a tree.
    const roots = await h.json<{ ids: string[] }>(await h.explore("/FileNode?parentId="));
    expect(roots.ids).toEqual([ids.dir(ERIC)]);
  });
});

// ---- _links --------------------------------------------------------------

/** Every href in a `_links` block, with what it claims to be. */
interface Claim {
  href: string;
  type: string;
  id?: string;
  list?: true;
}

function claims(links: unknown): Claim[] {
  if (links === null || typeof links !== "object") return [];
  return Object.values(links as Record<string, unknown>).flatMap((v) =>
    Array.isArray(v) ? (v as Claim[]) : [v as Claim],
  );
}

describe("_links: a rendering of ids the payload already carries", () => {
  it("an Email links to its thread, its mailboxes and its attachment's FileNode", async () => {
    const h = await harness();
    const body = await h.json<{ _links: Record<string, unknown> }>(
      await h.explore(`/Email/${ids.email(ERIC, 1)}`),
    );
    const byRel = body._links;
    expect((byRel.thread as Claim).id).toBe(ids.thread(ERIC, 1));
    expect((byRel.mailboxes as Claim[]).map((l) => l.id)).toEqual([ids.inbox(ERIC)]);
    // attachments[].fileNodeId — the one cross-realm id an Email carries.
    expect((byRel.files as Claim[]).map((l) => l.id)).toEqual([ids.file(ERIC, 1)]);
  });

  it("blobId is deliberately NOT a link — there is no Blob/get to call", async () => {
    const h = await harness();
    const body = await h.json<{ blobId: string; _links: Record<string, unknown> }>(
      await h.explore(`/Email/${ids.email(ERIC, 1)}`),
    );
    expect(body.blobId).toBe(`blob_${ERIC}`);
    for (const c of claims(body._links)) {
      expect(c.href, "no link may point at a blob").not.toContain("blob_");
    }
  });

  it("an email with no attachments emits no files link — absence, not a null link", async () => {
    const h = await harness();
    const body = await h.json<{ _links: Record<string, unknown> }>(
      await h.explore(`/Email/${ids.email(ERIC, 3)}`),
    );
    expect(body._links).not.toHaveProperty("files");
  });

  it("EVERY link emitted, on every type, is fetchable and returns what it claims", async () => {
    const h = await harness();
    const seen: string[] = [];

    for (const type of TYPE_NAMES) {
      const spec = TYPES[type]!;
      // Reach every object of every type: through its list where JMAP has one,
      // and through an Email's `_links.thread` for the one that has none.
      const objects: Array<Record<string, unknown>> = spec.listable
        ? (await h.json<{ list: Array<Record<string, unknown>> }>(await h.explore(`/${type}`))).list
        : [await h.json<Record<string, unknown>>(await h.explore(`/Thread/${ids.thread(ERIC, 1)}`))];

      expect(objects.length, `${type} seeded nothing to walk`).toBeGreaterThan(0);

      for (const obj of objects) {
        for (const c of claims(obj._links)) {
          const path = c.href.slice(`https://${EXPLORE_HOST}`.length);
          expect(c.href.startsWith(`https://${EXPLORE_HOST}/`), c.href).toBe(true);
          const res = await h.explore(path);
          expect(res.status, `${c.href} did not resolve`).toBe(200);
          const linked = await h.json<Record<string, unknown>>(res);
          if (c.id !== undefined) {
            // THE assertion: an object link returns the object it named. A
            // fabricated id lands on a 404 above; a link to the WRONG existing
            // object lands here.
            expect(linked.id, `${c.href} returned a different object`).toBe(c.id);
            expect((linked._meta as { type: string }).type).toBe(c.type);
          } else {
            expect(c.list).toBe(true);
            expect((linked._meta as { type: string }).type).toBe(c.type);
            expect(Array.isArray(linked.list)).toBe(true);
          }
          seen.push(c.href);
        }
      }
    }

    // Guard against the whole test passing because nothing emitted a link.
    expect(seen.length).toBeGreaterThanOrEqual(15);
  });
});

// ---- _next ---------------------------------------------------------------

describe("_next: JMAP's own paging, re-expressed as a URL", () => {
  it("walks the whole collection exactly once and terminates", async () => {
    const h = await harness();
    let url: string | undefined = `/Email?limit=2`;
    const collected: string[] = [];
    let pages = 0;

    while (url !== undefined) {
      const body: { ids: string[]; _next?: string } = await h.json<{
        ids: string[];
        _next?: string;
      }>(await h.explore(url));
      collected.push(...body.ids);
      pages += 1;
      expect(pages, "paging did not terminate").toBeLessThan(10);
      url = body._next ? body._next.slice(`https://${EXPLORE_HOST}`.length) : undefined;
    }

    expect(pages).toBe(3); // 2 + 2 + 1: a short page ends the walk
    expect(collected).toHaveLength(EMAIL_COUNT);
    expect(new Set(collected).size).toBe(EMAIL_COUNT);
  });

  it("_next preserves the filter it was paging under", async () => {
    const h = await harness();
    const body = await h.json<{ _next: string }>(
      await h.explore(`/Email?limit=2&inMailbox=${ids.inbox(ERIC)}`),
    );
    expect(body._next).toContain(`inMailbox=${ids.inbox(ERIC)}`);
    expect(body._next).toContain("position=2");
  });

  it("a collection with no more pages emits no _next", async () => {
    const h = await harness();
    const body = await h.json<Record<string, unknown>>(await h.explore("/Mailbox"));
    expect(body).not.toHaveProperty("_next");
  });
});

// ---- isolation -----------------------------------------------------------

describe("isolation: another account, another tenant", () => {
  for (const other of [ALLEN, ZED]) {
    it(`every type refuses ?accountId=${other}`, async () => {
      const h = await harness();
      for (const type of TYPE_NAMES) {
        const spec = TYPES[type]!;
        if (spec.listable) {
          const res = await h.explore(`/${type}?accountId=${other}`);
          expect(res.status, `${type} list leaked ${other}`).toBe(404);
          expect((await h.json<{ error: { type: string } }>(res)).error.type).toBe("accountNotFound");
        }
        const one = await h.explore(`/${type}/anything?accountId=${other}`);
        expect(one.status, `${type} object leaked ${other}`).toBe(404);
        expect((await h.json<{ error: { type: string } }>(one)).error.type).toBe("accountNotFound");
      }
    });

    it(`another account's ids are not reachable through Eric's account (${other})`, async () => {
      const h = await harness();
      const probes = [
        `/Email/${ids.email(other, 1)}`,
        `/Mailbox/${ids.inbox(other)}`,
        `/Thread/${ids.thread(other, 1)}`,
        `/ContactCard/${ids.card(other, 1)}`,
        `/AddressBook/${ids.book(other)}`,
        `/Calendar/${ids.calendar(other)}`,
        `/CalendarEvent/${ids.event(other, 1)}`,
        `/FileNode/${ids.file(other, 1)}`,
      ];
      for (const path of probes) {
        const res = await h.explore(path);
        expect(res.status, `${path} was served`).toBe(404);
        const text = await res.clone().text();
        const body = await h.json<Record<string, unknown>>(res);
        // Only `error`, `_self` and `_meta` — no object, no list, no notFound
        // roster that would confirm the id exists somewhere else.
        expect(Object.keys(body).sort(), path).toEqual(["_meta", "_self", "error"]);
        expect((body.error as { type: string }).type).toBe("notFound");
        expect((body._meta as { accountId: string }).accountId).toBe(ERIC);
        // The other account's id may appear only as the echo of what was
        // asked for. Its DATA — every seeded display string ends in the
        // account id, after a space — must not.
        expect(text, `${path} leaked data from ${other}`).not.toContain(` ${other}`);
      }
    });
  }

  it("no response Eric can obtain contains another account's data", async () => {
    const h = await harness();
    const paths = [
      "/",
      ...TYPE_NAMES.filter((t) => TYPES[t]!.listable).map((t) => `/${t}`),
      `/Email/${ids.email(ERIC, 1)}`,
      `/Thread/${ids.thread(ERIC, 1)}`,
    ];
    for (const path of paths) {
      const text = await (await h.explore(path)).text();
      expect(text, `${path} mentioned ${ALLEN}`).not.toContain(ALLEN);
      expect(text, `${path} mentioned ${ZED}`).not.toContain(ZED);
    }
  });
});

// ---- scopes --------------------------------------------------------------

describe("a missing scope refuses exactly as JMAP would", () => {
  it("403 forbidden, with the same type and description the JMAP method produces", async () => {
    // `admin` is control-plane only and implies nothing — not even `read`.
    const h = await harness({ scopes: ["admin"] });

    const viaExplorer = await h.explore(`/Email/${ids.email(ERIC, 1)}`);
    expect(viaExplorer.status).toBe(403);
    const refused = await h.json<{ error: { type: string; description: string } }>(viaExplorer);

    // The same call over the ordinary JMAP door, with the same credential.
    const viaJmap = await h.api("POST", "/api/jmap", {
      headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
        methodCalls: [["Email/get", { accountId: ERIC, ids: [ids.email(ERIC, 1)] }, "c0"]],
      }),
    });
    const jmapBody = await h.json<{ methodResponses: Array<[string, { type: string; description: string }]> }>(
      viaJmap,
    );
    const [name, args] = jmapBody.methodResponses[0]!;

    expect(name).toBe("error");
    expect(refused.error).toEqual(args);
    expect(refused.error.description).toBe('token lacks the "read" scope');
  });

  it("the refusal covers every projected type, list and object alike", async () => {
    const h = await harness({ scopes: ["admin"] });
    for (const type of TYPE_NAMES) {
      if (TYPES[type]!.listable) {
        expect((await h.explore(`/${type}`)).status, `${type} list`).toBe(403);
      }
      expect((await h.explore(`/${type}/whatever`)).status, `${type} object`).toBe(403);
    }
  });
});

// ---- read-only, and no credential in a URL -------------------------------

describe("read-only", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    it(`${method} on the explore host is refused before any credential is read`, async () => {
      const h = await harness();
      const res = await h.exploreWith(method, "/Email");
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
      expect((await h.json<{ error: { type: string } }>(res)).error.type).toBe("forbidden");
    });
  }
});

describe("no credential ever appears in a URL", () => {
  it("refuses ?access_token= and ?token= outright", async () => {
    const h = await harness();
    for (const param of ["access_token", "token"]) {
      const res = await h.explore(`/Email?${param}=${h.token}`);
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain(h.token);
    }
  });

  it("scans every URL the explorer emits, across every type", async () => {
    const h = await harness();
    const secrets = [h.token, h.cookie, "bm_", "access_token", "code_verifier"];
    const paths = [
      "/",
      ...TYPE_NAMES.filter((t) => TYPES[t]!.listable).map((t) => `/${t}?limit=2`),
      `/Email/${ids.email(ERIC, 1)}`,
      `/Thread/${ids.thread(ERIC, 1)}`,
    ];

    let urls = 0;
    for (const path of paths) {
      const body = (await (await h.explore(path)).json()) as unknown;
      for (const value of walkStrings(body)) {
        if (!value.startsWith("https://")) continue;
        urls += 1;
        for (const secret of secrets) {
          expect(value, `${path} emitted a URL containing "${secret}"`).not.toContain(secret);
        }
        expect(value).not.toMatch(/[?&](token|access_token|code)=/);
      }
    }
    expect(urls).toBeGreaterThan(30);
  });
});

// ---- off by default ------------------------------------------------------

describe("off by default", () => {
  it("with EXPLORE_HOST unset the hostname serves nothing, cookie or not", async () => {
    const h = await harness({ off: true });
    const res = await h.explore("/Email");
    expect(res.status).toBe(401);
    // The API's refusal, not the explorer's — the explorer does not exist here.
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.text()).toContain("unauthorized");
  });

  it("with EXPLORE_HOST unset no cookie is honoured anywhere", async () => {
    const h = await harness({ off: true });
    expect((await h.api("GET", `/api/blobs/${ERIC}`, { headers: { cookie: `bm_explore=${h.cookie}` } })).status)
      .toBe(401);
  });
});

// ---- the sign-in page ----------------------------------------------------

describe("the one scrap of HTML", () => {
  it("no cookie → a 401 page with a sign-in link and nothing else", async () => {
    const h = await harness();
    const res = await h.explore("/", { cookie: null });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await res.text();
    expect(html).toContain('href="/oauth/start"');
    expect(html).not.toContain("bm_");
    // No script, no stylesheet, no form: `default-src 'none'` has to be true.
    expect(html).not.toMatch(/<script|<link|<form/i);
  });

  it("an expired cookie is the same as no cookie", async () => {
    const h = await harness();
    const stale = await mintExploreCookie(COOKIE_KEY, "p_eric", ["read"], Date.now() - 10_000, 1);
    const res = await h.explore("/", { cookie: stale });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("a forged cookie is refused, and refused identically", async () => {
    const h = await harness();
    const forged = await mintExploreCookie("not-the-key", "p_eric", ["read"], Date.now());
    expect((await h.explore("/", { cookie: forged })).status).toBe(401);
    expect((await h.explore("/", { cookie: "garbage" })).status).toBe(401);
  });

  it("a bearer works too — the explorer is a JMAP door like any other", async () => {
    const h = await harness();
    const res = await h.explore("/Email", { cookie: null, bearer: h.token });
    expect(res.status).toBe(200);
  });
});

// ---- helpers -------------------------------------------------------------

function* walkStrings(value: unknown): Generator<string> {
  if (typeof value === "string") {
    yield value;
  } else if (Array.isArray(value)) {
    for (const v of value) yield* walkStrings(v);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) yield* walkStrings(v);
  }
}
