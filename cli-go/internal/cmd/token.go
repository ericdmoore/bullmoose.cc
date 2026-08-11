package cmd

// TokenCreateScopes resolves the scopes for `bullmoose token create`.
//
// cli/007 (`.feedback/fromClaude/cli/007`): this used to default to the widest
// scope the self-service API can express ("mail", which satisfies everything
// except admin) whenever --scopes was omitted. So the shortest invocation
// minted the broadest credential — and that token is precisely the one pasted
// into third-party clients. The TypeScript fix makes --scopes REQUIRED for
// token create (parseScopeFlag(opts.scopes, SELF_SERVICE_SCOPES, /*required*/
// true) in packages/cli/src/tokens.ts:151): an omitted flag is a usage error
// (exit 2), never a wide default. `login` keeps an optional --scopes because it
// is the bootstrap; this seam is `token create` specifically, where the caller
// already holds a token and demanding one word costs them nothing.
//
// scopes is the raw --scopes value, or nil when the flag was absent. T6
// implements this; until then it returns ErrNotImplemented so the test skips.
// The implementation must return a non-nil error when scopes is nil, and must
// never substitute a default scope of any kind.
func TokenCreateScopes(scopes *string) ([]string, error) {
	return nil, ErrNotImplemented
}
