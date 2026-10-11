# Private expense tracker

A small HTTP API for accounts and private USD expense records. It includes real sign-in, ownership checks on every expense query, durable retry protection, field-specific errors, cursor pagination, and a persistent SQLite database. There are no third-party dependencies.

Repository: https://github.com/saikatdas47/expense-tracker

Public deployment URL: pending deployment by the repository owner. This README will be updated after the public service is verified.

## Run locally

Use Node.js 22.13 or newer (Node.js 24 is recommended):

```sh
npm start
```

Default URL: `http://localhost:3003`. `PORT` controls the port; `DB_PATH` controls the database file, defaulting to `./data/expenses.db`. Tables and the database directory are created at startup. Run `npm test` to verify authentication, ownership, concurrent retries, restart persistence, validation, pagination, logout, and exact session expiry.

## Deploy as a Render Web Service

Create a Web Service from this public GitHub repository. Choose **Node**, branch **main**, and leave Root Directory empty.

| Setting | Value |
| --- | --- |
| Build Command | `node --version` |
| Start Command | `npm start` |
| Health Check Path | `/health` |
| Environment: NODE_VERSION | `24` |
| Environment: DB_PATH | `/var/data/expenses.db` |
| Persistent Disk Mount Path | `/var/data` |

Render supplies `PORT`; do not set it yourself. No API key, JWT secret, or `.env` file is required: this application uses random opaque sessions rather than JWTs.

**Persistent storage is required.** Select an instance type that supports a persistent disk and add one at `/var/data`. This can incur hosting charges; the owner must choose and approve the plan in Render. A free instance without a disk can run a disposable demo with `DB_PATH=./data/expenses.db`, but accounts, sessions, expenses, and retry receipts can disappear on restart or redeploy. It does not provide the durable behavior documented here. Keep one instance using the same persistent database file. Independent SQLite files across replicas do not coordinate.

Render provides HTTPS. A Dockerfile is also included for other hosts; mount a persistent volume at `/app/data` when using it.

## Data model

| Table | Purpose |
| --- | --- |
| users | Unique lowercase email, salted scrypt password hash, creation time |
| sessions | SHA-256 hash of a random bearer token, user foreign key, expiry |
| expenses | User foreign key, title, positive integer amount in cents, creation time |
| idempotency | Composite primary key `(user_id, key)`, normalized request hash, original response JSON |

SQLite foreign keys are enabled on every connection. Money uses integer cents. Each expense belongs to exactly one account. The `(user_id, id DESC)` index supports private cursor-paginated lists.

## API

| Method | Endpoint | Behavior |
| --- | --- | --- |
| POST | `/auth/signup` | Register with email and password; return user, token and expiresAt; 201 |
| POST | `/auth/login` | Sign in with email and password; return a new session; 200 |
| POST | `/auth/logout` | Revoke the current bearer token; 200 |
| GET | `/expenses?limit=20&before=123` | Return own expenses newest first, with items and nextCursor |
| POST | `/expenses` | Create an expense with required `Idempotency-Key`; 201 on first call and replay |
| GET | `/expenses/:id` | Return an expense only if owned by the authenticated user |
| DELETE | `/expenses/:id` | Delete an expense only if owned by the authenticated user |
| GET | `/health` | Public readiness endpoint |
| GET | `/` | Public service information and repository link |

Expense endpoints and logout require `Authorization: Bearer <token>`. Missing, malformed, expired, and revoked credentials return **401** with `WWW-Authenticate: Bearer`. Using another valid user's token does not grant access: detail reads and deletes include `user_id` in their database predicates and return **404** for unowned rows. Lists include only the authenticated user's rows. A caller-supplied `userId` is ignored; ownership comes exclusively from the verified session.

Signup/login require an email address of at most 254 characters and a password between 8 and 128 characters. Passwords are salted and hashed with scrypt; plaintext passwords are never stored. Session tokens contain 32 random bytes, expire after seven days, and only their SHA-256 hashes are stored. Signup and login share a per-process limit of 30 attempts per remote IP per minute; 429 responses include `Retry-After`. Behind a proxy this may group clients under the proxy IP, so use provider-level rate limits for larger deployments.

## Example requests

Register a disposable account using your own password:

```sh
curl -i -H 'Content-Type: application/json' \
  -d '{"email":"your-demo@example.com","password":"choose-your-own-password"}' \
  http://localhost:3003/auth/signup
```

Set `TOKEN` in your local shell to the returned token; never commit it. Then create an expense:

```sh
curl -i -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: lunch-2026-10-11' \
  -d '{"title":"Lunch","amountCents":1250}' http://localhost:3003/expenses
```

Repeating that command returns **the same 201 status and original JSON body**, including the expense ID and creation time.

```sh
curl -H "Authorization: Bearer $TOKEN" 'http://localhost:3003/expenses?limit=20'
curl -H "Authorization: Bearer $TOKEN" http://localhost:3003/expenses/1
```

Use returned IDs and cursors rather than assuming the example ID exists. Replace the local base URL with the public Render URL after deployment.

## Retry-safe writes

The client sends an `Idempotency-Key` of 1–128 letters, digits, underscores, or hyphens. Keys are scoped to the authenticated user. The server normalizes the title by trimming it and hashes the title plus integer amount. It persists the expense and original response together in one `BEGIN IMMEDIATE` transaction.

An identical retry finds the stored receipt and returns it without adding a row. Reusing a key with different title or amount returns **409** naming `Idempotency-Key`; use a new key for a new expense. The receipt survives a crash after commit but before the response, and it coordinates concurrent requests across processes sharing the same database. The key is not expired or reused. Deleting an expense keeps its receipt: a retry returns the original create response and does not recreate the deleted expense. Receipts therefore consume storage over time; this small implementation favors an explicit permanent deduplication guarantee.

## Error interface

Malformed JSON and invalid input return **400**, for example:

```json
{"error":"validation","fields":{"title":"must be a nonempty string of at most 200 characters","amountCents":"must be an integer between 1 and 100000000"}}
```

Malformed JSON names `body`; invalid list parameters name `limit` or `before`. Expense bodies are limited to 16 KiB. Titles are 1–200 characters and amounts are integer cents from 1 to 100,000,000. The list limit is 1–100. A null nextCursor means no further current rows remain.

| Status | Caller action |
| --- | --- |
| 400 | Correct the named fields |
| 401 | Sign in and supply a current token |
| 404 | Check the ID; it may not belong to this account |
| 409 | Use an unregistered email or a new idempotency key as indicated |
| 405 | Use a documented HTTP method |
| 429 | Wait for Retry-After |
| 500 | Report the diagnostic ID; retry expense creation using the same key |

Unexpected errors expose only `error: "internal"` and an ID. Server logs contain the ID and error class, never password, token, request body, or full database error. Private and authentication responses use `Cache-Control: no-store`; caching those shared responses would risk leaking user data or retaining credentials.

## What the tests prove

The HTTP integration test creates Alice and Bob with distinct sessions. Alice creates an expense; Bob gets 404 reading or deleting it and an empty private list. Alice can still read it afterward. Tests also attempt a forged body userId, ensuring the expense remains Alice's.

Twenty simultaneous identical create requests are sent to **two separate server processes sharing one isolated database**. Every response must have the same status and body. The test checks one durable receipt, a conflict on changed payload, independently scoped keys, persistence after a process restart, and no recreation after deletion. A separate test injects a clock and proves a session is invalid exactly at expiry. Temporary databases are cleaned up.

## Secrets and limits

No deployment secret is required or committed. Runtime database files contain private account data and are excluded from Git, Docker build contexts, and this repository. Passwords and tokens belong only in the client or runtime storage, never the source or logs. Do not use real financial data for the public assessment demo.

This focused service has no password reset, email verification, account deletion, UI, payment processing, or multi-host database. Protect the persistent disk, maintain backups, and add those features before treating it as a general-purpose financial product.

The linked course lesson was inaccessible through the browsing tool. Implementation follows the supplied brief; the lesson still needs to be read in the signed-in course session.
