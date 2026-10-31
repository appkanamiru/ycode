# Caddy with the Cloudflare DNS module, for the wildcard certificate of the
# platform domain (Let's Encrypt issues wildcards only via the DNS challenge).
FROM caddy:2.11.7-builder AS builder
RUN xcaddy build v2.11.7 --with github.com/caddy-dns/cloudflare@v0.2.4

FROM caddy:2.11.7
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
