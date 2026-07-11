# TokenInside

TokenInside is a Feishu-based token request, management, and LLM API gateway for teams that want to bind generated API keys to Feishu users while forwarding compatible `/v1` requests to a NewAPI backend.

## What It Provides

- Feishu OAuth login and session binding.
- Token request and approval workflow.
- User-facing token status, quota, and usage views.
- Admin-facing user, quota, department, and usage management.
- OpenAI-compatible `/v1` proxying through per-user keys.
- Docker Compose deployment with PostgreSQL and health checks.

## Repository Layout

```text
app/          Next.js app routes and API handlers
components/   React UI components
lib/          Feishu, NewAPI, storage, billing, and admin logic
scripts/      Database, production preflight, and deployment helper scripts
```

## Local Development

Install dependencies:

```bash
npm ci
```

Run type checks:

```bash
npm run typecheck
```

Run a production build:

```bash
npm run build
```

Run the local development server:

```bash
npm run dev
```

The default development port is `16878`.

## Docker Deployment

TokenInside publishes container images to GitHub Container Registry:

```text
ghcr.io/voidintheshell/tokeninside
```

Common tags:

```text
staging
production
sha-<commit>
v<release>
```

For a standalone Docker Compose deployment:

```bash
cp .env.example .env
docker compose -f docker-compose.example.yml up -d
docker compose -f docker-compose.example.yml run --rm --no-deps --entrypoint node tokeninside scripts/db-migrate.mjs
```

Production-style deployments should set `TOKENINSIDE_IMAGE` to a fixed tag, for example:

```text
TOKENINSIDE_IMAGE=ghcr.io/voidintheshell/tokeninside:sha-abcdef1
```

Runtime secrets must be provided through the server-side environment file. Do not bake Feishu, NewAPI, database, or session secrets into the image.

## CI/CD

GitHub Actions is the canonical deployment path:

```text
.github/workflows/tokeninside-ci-cd.yml
```

Every push to `main` validates the application, publishes a Linux/AMD64 image to GHCR, and automatically dispatches the immutable `sha-<commit>` image to the dedicated LA self-hosted runner. The deployer creates a PostgreSQL recovery point, runs versioned migrations under a PostgreSQL advisory lock, checks the migrated schema, replaces only the application service, and verifies local plus public health endpoints.

The LA runner is installed as the systemd service `actions.runner.VoidInTheShell-TokenInside.tokeninside-la-staging.service` under the `tokeninside-ci` account. It connects outward to GitHub, so staging deployment does not require GitHub to hold an SSH private key or connect inbound to the server. The staging job is restricted to its labels (`self-hosted`, `linux`, `x64`, `tokeninside-la`, `staging`).

The `staging` GitHub Environment has only these deployment values:

| Type | Name | Value for LA |
| --- | --- | --- |
| Variable | `DEPLOY_DIR` | `/opt/tokeninside` |
| Variable | `APP_URL` | `https://ti.kumiko-love.com` |

The server retains runtime `.env` locally; CI never uploads it. Every release stores its Compose source under `.release-source/<commit>`, records the image, OCI revision, backup path, prior image, and final status in `.deploy/releases.log`. If an application update fails after a successful migration, the deployer restores the preceding application image. It never restores PostgreSQL automatically: migrations must follow the backward-compatible expand/contract pattern described in [`scripts/migrations/README.md`](scripts/migrations/README.md).

Production is deliberately outside this automatic staging path. Version tags and the protected `production` GitHub Environment remain the route for a later production rollout.

## Configuration

Use `.env.example` as a starting point and replace every placeholder before running a real deployment.

Important configuration groups:

- Feishu application credentials and callback verification keys.
- NewAPI backend URL and control credential.
- Session secret.
- PostgreSQL connection string and pool settings.
- TokenInside image tag and resource tuning values.

## License

No license has been declared yet.
