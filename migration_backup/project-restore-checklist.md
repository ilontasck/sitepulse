# Project Restore Checklist

Use this after cloning SitePulse on the new Mac.

```bash
git status
node -v
pnpm --version
./setup.sh
pnpm test
pnpm test:e2e
pnpm start
```

Expected result:

- `.env` exists locally and is ignored by Git.
- `data/` exists.
- `node_modules/` exists locally and is ignored by Git.
- Unit/API tests pass.
- Playwright e2e tests pass.
- App opens at `http://localhost:3000`.

