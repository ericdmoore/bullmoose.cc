# Common core, cross-compiled — the platform "branches" are just targets.
LDFLAGS := -trimpath -ldflags="-s -w"

.PHONY: build all vet clean
build:
	go build $(LDFLAGS) -o dist/popcorn ./cmd/popcorn

all: vet
	GOOS=darwin GOARCH=arm64 go build $(LDFLAGS) -o dist/popcorn-darwin-arm64 ./cmd/popcorn
	GOOS=linux  GOARCH=amd64 go build $(LDFLAGS) -o dist/popcorn-linux-amd64  ./cmd/popcorn
	GOOS=linux  GOARCH=arm64 go build $(LDFLAGS) -o dist/popcorn-linux-arm64  ./cmd/popcorn

vet:
	go vet ./...

clean:
	rm -rf dist popcorn
