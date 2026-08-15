# Contributing

Contributions are welcome for security, compatibility, accessibility, documentation, and focused product improvements.

## Setup

Use Node.js `^22.19.0` or `>=24.0.0` and the pnpm version declared in `package.json`.

```powershell
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm run prepare
```

## Pull requests

- Keep changes scoped and explain user impact.
- Add or update tests for authentication, proxying, lifecycle, downloader, or visible UI behavior.
- Update both README languages when their shared behavior changes.
- Do not commit secrets, real tunnel URLs, personal paths, local addresses, generated credentials, or build output outside the declared package artifacts.
- Run `pnpm run check` and report the commands actually run.

Security reports belong in private vulnerability reporting, not public pull requests or issues.
