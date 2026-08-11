module github.com/ericdmoore/bullmoose.cc/cli-go

// Pure standard library, and s08 keeps it that way until a task needs
// otherwise: `.plans/s08-go-cli/devPlan.md:156` decides SQLite (modernc) at T5+,
// not here. A shim with no dependencies is a shim whose behaviour is entirely
// in this directory.
go 1.26
