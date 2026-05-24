# `get-connection` – credential handoff helper

Single credential-minting seam for Lakebase-paired workflows. Replaces ad-hoc shell scripts (`refresh-token.sh`, hand-rolled JDBC URL builders) with one helper that produces two output shapes from the same OAuth substrate.

Every other workflow op that touches Lakebase resolves credentials through this module. A CI grep guard (`.github/workflows/grep-guard.yml`) fails the build if any other file calls `databricks postgres generate-database-credential`.

## --output dsn

A short-lived `postgresql://` URL for language-agnostic callers (Flyway, Alembic, `psql`, ad-hoc tooling). Operator principal – uses whichever Databricks identity the CLI is currently authenticated as.

### CLI

```bash
lakebase-get-connection --output dsn --instance <project-id> --branch <branch-id>
# -> postgresql://user%40databricks.com:eyJ...@host:5432/databricks_postgres?sslmode=require

# Pipe straight into psql:
psql "$(lakebase-get-connection --output dsn --instance proj-abc --branch br-feature)"

# Flyway:
flyway -url="$(lakebase-get-connection --output dsn --instance proj-abc --branch br-feature)" migrate

# Alembic – write to .env:
echo "DATABASE_URL=$(lakebase-get-connection --output dsn ...)" > .env
```

Add `--json` to get the parsed components in JSON:

```bash
lakebase-get-connection --output dsn --instance proj-abc --branch br-feature --json
# { "url": "postgresql://...", "host": "...", "port": 5432, "database": "...", "user": "...", "endpointPath": "..." }
```

### Module

```ts
import { getConnection } from "@databricks-solutions/lakebase-app-dev-kit";

const { url, host, database, user } = await getConnection({
  output: "dsn",
  instance: "proj-abc",
  branch: "br-feature",
});
```

## --output pool

A long-lived `@databricks/lakebase` `pg.Pool` with refresh-on-connect. For JS/TS callers that hold a connection across requests.

> Not available on the CLI – `pg.Pool` is a runtime object and can't be serialized to stdout. The CLI prints an error and exits with code 2 if you pass `--output pool`.

```ts
import { getConnection } from "@databricks-solutions/lakebase-app-dev-kit";

const pool = await getConnection({
  output: "pool",
  instance: "proj-abc",
  branch: "br-feature",
});

const { rows } = await pool.query("SELECT current_database() AS db, current_user AS u");
```

### On-Behalf-Of (OBO) via AppKit

Pass your own `WorkspaceClient` (from `@databricks/sdk-experimental`) – typically the one AppKit's `asUser(req)` returns – to scope the connection to the request user:

```ts
import { getConnection } from "@databricks-solutions/lakebase-app-dev-kit";

app.get("/me", async (req, res) => {
  const pool = await getConnection({
    output: "pool",
    instance: "proj-abc",
    branch: "br-feature",
    workspaceClient: req.appkit.asUser(req), // OBO
  });
  const { rows } = await pool.query("SELECT current_user");
  res.json(rows[0]);
});
```

## Args

| Arg | Type | Default | Notes |
|---|---|---|---|
| `output` | `"dsn"` \| `"pool"` | required | Determines return shape |
| `instance` | string | required | Lakebase project id (`projects/<instance>`) |
| `branch` | string | required | Branch id (`.../branches/<branch>`) |
| `endpointName` | string | `"primary"` | Endpoint identifier on the branch |
| `database` | string | `$PGDATABASE` then `"databricks_postgres"` | DB name |
| `workspaceClient` | unknown | undefined | Pool-only; AppKit/SDK workspace client for OBO |

## Why one helper

The control plane (`databricks postgres ...` CLI) and data plane (`@databricks/lakebase` driver) are different surfaces. Mixing them across many call sites is what produced the `post-checkout.sh` / `lakebaseService.ts` drift incident. This helper concentrates that handoff into a single place – one DSN encoder, one Pool factory, one path that the CI grep guard can prove is the only path.

JVM and Python callers (Flyway, Alembic) can't import `@databricks/lakebase`. They use `--output dsn` and accept the short-lived window. That intentional split happens at the same seam as the JS Pool path, so the two stay symmetric even as the language paths diverge.
