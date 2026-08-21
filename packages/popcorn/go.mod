module bullmoose.cc/popcorn

go 1.23

// The BUILD pin, which the `go` line above is not: that is a LANGUAGE
// FLOOR. Go ships security fixes in the statically-linked stdlib, so the
// toolchain that compiles a binary IS its patch level. Without this line
// a laptop build and a CI build can differ silently — which is exactly
// how the deployed popcorn ended up on go1.26.5 while 1.26.7 was current
// (#241). GOTOOLCHAIN fetches this automatically, so no local install
// has to match. Raise it on Go's schedule; raise the `go` floor only
// when a feature actually needs it.
toolchain go1.26.7
