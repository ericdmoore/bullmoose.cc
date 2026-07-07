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
