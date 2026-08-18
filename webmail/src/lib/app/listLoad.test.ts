import { describe, expect, it } from "vitest";
import { errorMessage, runListLoad } from "./listLoad";

// The race these tests pin is the one the mail list actually loses: a mailbox
// switch starts a second load while the first is still in flight, and promises
// do not un-start. Every case below drives the two loads in a DEFINITE order —
// the superseded one resolving LAST, which is the interesting order and the
// likely one (a slow mailbox is why you clicked away) — so nothing here depends
// on timer luck.

/** A promise plus the handles to settle it exactly when the test says to. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every already-settled promise's continuations run. */
const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Records what a load reported, in order, so assertions read as a timeline. */
function recorder() {
  const log: string[] = [];
  return {
    log,
    handlers: (tag: string) => ({
      onResult: (rows: string[]) => log.push(`${tag}:result=${rows.join(",")}`),
      onError: (message: string) => log.push(`${tag}:error=${message}`),
      onSettled: () => log.push(`${tag}:settled`),
    }),
  };
}

describe("runListLoad — a superseded load never writes", () => {
  it("drops the result of a load that is no longer current", async () => {
    const rec = recorder();
    // `current` stands in for AppShell's `storeRef.current === store`.
    let current = "A";
    const a = deferred<string[]>();
    const b = deferred<string[]>();

    runListLoad(
      () => a.promise,
      () => current === "A",
      rec.handlers("A"),
    );
    // The mailbox switch: B becomes the live load, A is superseded.
    current = "B";
    runListLoad(
      () => b.promise,
      () => current === "B",
      rec.handlers("B"),
    );

    b.resolve(["b1", "b2"]);
    await drain();
    // A answers LAST — the order that used to leave the wrong mailbox on screen.
    a.resolve(["a1", "a2", "a3"]);
    await drain();

    expect(rec.log).toEqual(["B:result=b1,b2", "B:settled"]);
    expect(rec.log.some((line) => line.startsWith("A:"))).toBe(false);
  });

  it("leaves the spinner to the load that owns it", async () => {
    // The `finally` half, stated on its own: a superseded load settling must not
    // close the CURRENT load's spinner, or an in-flight list renders as empty.
    const rec = recorder();
    let current = "A";
    const a = deferred<string[]>();

    runListLoad(
      () => a.promise,
      () => current === "A",
      rec.handlers("A"),
    );
    current = "B"; // B is now the live load; A is stale but still in flight.

    a.resolve(["a1"]);
    await drain();

    expect(rec.log).toEqual([]);
  });

  it("does not report a failure from a list the user has left", async () => {
    const rec = recorder();
    let current = "A";
    const a = deferred<string[]>();

    runListLoad(
      () => a.promise,
      () => current === "A",
      rec.handlers("A"),
    );
    current = "B";

    a.reject(new Error("Email/query failed: serverFail"));
    await drain();

    expect(rec.log).toEqual([]);
  });

  it("delivers result then settled while the load is still current", async () => {
    const rec = recorder();
    const a = deferred<string[]>();

    runListLoad(
      () => a.promise,
      () => true,
      rec.handlers("A"),
    );
    a.resolve(["a1"]);
    await drain();

    expect(rec.log).toEqual(["A:result=a1", "A:settled"]);
  });

  it("reports a failure — once — and still closes the spinner", async () => {
    // A rejection must not strand `loading` at true: that is precisely the
    // "permanent Loading…" shape, and `finally` is what forbids it.
    const rec = recorder();
    const a = deferred<string[]>();

    runListLoad(
      () => a.promise,
      () => true,
      rec.handlers("A"),
    );
    a.reject(new Error("boom"));
    await drain();

    expect(rec.log).toEqual(["A:error=boom", "A:settled"]);
  });

  it("survives a synchronous throw from the load itself", async () => {
    // `store.loadMore()` is a method call; if it throws before returning a
    // promise the spinner must still close rather than hang.
    const rec = recorder();

    expect(() =>
      runListLoad<string[]>(
        () => {
          throw new Error("sync boom");
        },
        () => true,
        rec.handlers("A"),
      ),
    ).not.toThrow();
    await drain();

    expect(rec.log).toEqual(["A:error=sync boom", "A:settled"]);
  });
});

describe("errorMessage", () => {
  it("unwraps an Error to its message", () => {
    expect(errorMessage(new Error("Email/get failed"))).toBe("Email/get failed");
  });

  it("stringifies a non-Error rejection rather than showing nothing", () => {
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});
