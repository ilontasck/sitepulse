# Environment Template

Copy `.env.example` to `.env` on the new Mac. `setup.sh` does this automatically if `.env` is missing.

```text
HOST=127.0.0.1
PORT=3000
NODE_ENV=development
DATABASE_FILE_PATH=./data/sitepulse.sqlite
ADMIN_API_KEY=
RENDERED_AUDIT_ENABLED=false
RENDERED_AUDIT_TIMEOUT_MS=45000
RENDERED_AUDIT_MAX_CONCURRENCY=1
TELEMETRY_ENABLED=true
REQUEST_BODY_LIMIT_BYTES=32768
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=60
```

Manual values to restore:

- `ADMIN_API_KEY`, only if you used one locally.
- Any custom `PORT` or `DATABASE_FILE_PATH`.
