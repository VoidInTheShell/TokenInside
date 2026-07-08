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
docker compose -f docker-compose.example.yml exec tokeninside npm run db:migrate
```

Production-style deployments should set `TOKENINSIDE_IMAGE` to a fixed tag, for example:

```text
TOKENINSIDE_IMAGE=ghcr.io/voidintheshell/tokeninside:sha-abcdef1
```

Runtime secrets must be provided through the server-side environment file. Do not bake Feishu, NewAPI, database, or session secrets into the image.

## CI/CD

This repository contains both GitHub Actions and GitLab CI definitions:

```text
.github/workflows/tokeninside-ci-cd.yml
.gitlab-ci.yml
```

Both pipelines validate the app, build the Docker image, and publish to GHCR. Staging deployment is disabled by default and only runs when `DEPLOY_STAGING=true` is configured. Production deployment is manual or tag-driven and should be protected by environment controls.

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
