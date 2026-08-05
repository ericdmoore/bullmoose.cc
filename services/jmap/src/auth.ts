// Principal auth (tokens → accounts → grants) lives in auth-core so the
// anglebrackets DAV worker authenticates identically; this shim keeps
// the worker-local import path stable.
export * from "@bullmoose/auth-core/principal";
