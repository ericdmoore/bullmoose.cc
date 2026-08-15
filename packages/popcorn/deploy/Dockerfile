# popcorn — multi-arch build (linux/amd64 + linux/arm64 via buildx):
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -f deploy/Dockerfile -t popcorn:latest .
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
ARG TARGETOS TARGETARCH
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /popcorn ./cmd/popcorn

# distroless/static ships CA roots (needed for the JMAP HTTPS calls).
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /popcorn /popcorn
EXPOSE 995
ENTRYPOINT ["/popcorn"]

# Two things bite here, both from :nonroot (uid 65532), and neither of them
# announces itself as a container problem:
#
#   Binding :995. Docker sets net.ipv4.ip_unprivileged_port_start=0 inside the
#   container's netns, so the default POPCORN_LISTEN works; runtimes that do
#   not (some Kubernetes/podman configurations) give "permission denied" on a
#   port that looks fine in every log. Fix by publishing rather than binding:
#   -e POPCORN_LISTEN=:9995 -p 995:9995.
#
#   Reading the key. A mounted privkey.pem is usually 0600 root — unreadable
#   to uid 65532. popcorn treats that as fatal (tls.LoadX509KeyPair ->
#   log.Fatalf in cmd/popcorn/main.go), so the container exits immediately and
#   restarts forever instead of falling back to plaintext. Copy the pair to a
#   dedicated directory and chown it 65532 before mounting.
