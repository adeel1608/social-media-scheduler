# Contributing

Contributions are welcome under the MIT Licence.

## Local workflow

1. Use Node 24 and Corepack/pnpm 11.25.
2. Fork and create a focused branch.
3. Copy `.env.example` to `.env`; keep `VITE_DEMO_MODE=true` unless you own a separate integration environment.
4. Make changes without committing `.env`, media, tokens, provider responses or signed URLs.
5. Run:

```bash
corepack pnpm format
corepack pnpm check
corepack pnpm test:e2e
corepack pnpm audit --audit-level high
```

## Platform changes

Use official documentation only. Update `docs/PLATFORM_SUPPORT_MATRIX.md` with the verification date and source URLs. Do not add scraping, password login, browser-driven posting, silent visibility downgrade, automatic publish retry, or a mock production fallback.

Adapters accept an injected fetch function for mocked HTTP testing. Default CI must never contact a provider. A live test requires a separate owner-controlled environment, explicit `LIVE_TEST_CONFIRM=true`, provider approval, non-sensitive fixtures and a command that cannot run accidentally; document exactly what was live-tested.

## Database changes

Add a new timestamped forward migration. Preserve owner columns, RLS, auditability, independent target states and atomic claims. Run `corepack pnpm db:validate`. Avoid destructive migration rollback instructions.

## Pull requests

Describe architecture impact, user behavior, security/privacy impact, official docs checked, tests, screenshots for UI changes, deployment impact, and human actions. Never claim a mock as live verification.
