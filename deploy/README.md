# Deploying the multi-tenant platform

The platform runs as one Docker Compose stack:

| Service    | Role |
|------------|------|
| `app`      | Ycode (Next.js), the editor and every published site |
| `migrate`  | Runs database migrations, tenancy and the platform schema, then exits |
| `postgres` | All data: sites (per tenant), accounts, organizations, domains |
| `redis`    | Realtime collaboration between app instances (no persistent data) |
| `caddy`    | HTTPS: wildcard certificate for the platform, on-demand certificates for customers' domains |

Uploaded files live in the `uploads` volume, the database in `postgres-data`.

## Local run

Everything on your machine, with HTTPS from Caddy's local certificate
authority and email caught by Mailpit:

```sh
docker compose --env-file deploy/local.env \
  -f deploy/docker-compose.yml -f deploy/docker-compose.local.yml up -d --build
```

- Editor: https://app.localtest.me/ycode
- Sites: https://&lt;slug&gt;.localtest.me (`*.localtest.me` resolves to 127.0.0.1 in public DNS)
- Email (sign-in codes, invitations): http://localhost:8025

Ports 80 and 443 must be free. Browsers warn about the certificates until you
trust Caddy's local root certificate:

```sh
docker compose -p ycode cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-local-root.crt
```

Import `caddy-local-root.crt` as a trusted root certificate authority (Windows:
`certmgr.msc` → Trusted Root Certification Authorities; macOS: Keychain Access,
set to Always Trust), then restart the browser.

To start over: `docker compose -p ycode down -v` (deletes all data).

## Production

1. **Server**: Linux with Docker, ports 80 and 443 open. Note its public IPv4.
2. **DNS** at Cloudflare for your platform domain (e.g. `appkanamiru.cz`):
   - `app` → A record to the server
   - `*` → A record to the server

   Set both to **DNS only** (grey cloud), not proxied: customers' own domains
   CNAME to their site's subdomain, and Cloudflare's proxy refuses traffic for
   hostnames outside your account (error 1014). Caddy handles HTTPS instead.
3. **Cloudflare API token** for the wildcard certificate (Let's Encrypt issues
   wildcards only through a DNS challenge): Cloudflare dashboard → My Profile →
   API Tokens → Create Token → "Edit zone DNS" template, limited to the
   platform domain's zone. The `caddy` service is built with the Cloudflare
   module (`deploy/caddy/Dockerfile`); adjust the domains in `deploy/Caddyfile`
   if yours differ.
4. **Configuration**: `cp deploy/.env.example deploy/.env` and fill it in,
   including `CLOUDFLARE_API_TOKEN`.
   `BETTER_AUTH_SECRET` must be long and random (`openssl rand -base64 48`);
   changing it later signs everyone out.
5. **Start**:

   ```sh
   docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build
   ```

Customers add their own domains on the sites page: they create a TXT record to
prove ownership and a CNAME to their site's subdomain (or an A record to
`PLATFORM_DOMAIN_IPV4` for an apex domain). Caddy requests the certificate on
the first visit, after asking the app whether the domain is verified.

## Operations

- **Updates**: pull the new code and run the start command again; `migrate`
  applies new migrations before the app starts.
- **Backups**: the `postgres-data` and `uploads` volumes, e.g.
  `docker compose -p ycode exec postgres pg_dump -U ycode ycode > backup.sql`
  and an archive of the `uploads` volume.
- **Site limit** of an account (default 1):
  `docker compose -p ycode exec postgres psql -U ycode -d ycode -c "update platform.\"user\" set \"siteLimit\" = 3 where email = '...'"`
- **Several app instances** (behind a load balancer) need shared file storage
  for `uploads`; Redis already connects their realtime traffic.
