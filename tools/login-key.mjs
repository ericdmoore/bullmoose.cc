#!/usr/bin/env node
// Derive the `loginKey` that POST /auth/login expects.
//
// The server never sees a password: `handleLogin` (services/jmap/src/authRoutes.ts:44)
// takes a client-derived key and rejects anything that is not 64 hex chars
// (`isLoginKey`, packages/auth-core/src/index.ts:233). The stretch is deliberately
// on the client -- ~200-400ms of local CPU -- so login fits the Workers free-plan
// CPU cap. That is why you cannot curl this endpoint with a plaintext password.
//
// Mirrors `deriveLoginKey` (auth-core index.ts:238). Kept in plain Node with no
// imports so it runs before/without a build, which is the whole point of a
// debugging aid. `login-key.test.ts` asserts it agrees with the real function.
//
//   node tools/login-key.mjs eric@bullmoose.cc 'correct horse battery staple'
import { webcrypto as crypto } from "node:crypto";

export const LOGIN_SALT_LABEL = "bullmoose-login-v1:";
export const LOGIN_KEY_ITERATIONS = 600_000;

export async function deriveLoginKey(email, password) {
  const enc = new TextEncoder();
  const salt = await crypto.subtle.digest(
    "SHA-256",
    enc.encode(LOGIN_SALT_LABEL + email.toLowerCase()),
  );
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: LOGIN_KEY_ITERATIONS },
    key,
    256,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [email, password] = process.argv.slice(2);
  if (!email || !password) {
    console.error("usage: node tools/login-key.mjs <email> <password>");
    process.exit(2);
  }
  console.log(await deriveLoginKey(email, password));
}
