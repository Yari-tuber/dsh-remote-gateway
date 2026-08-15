# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository. Do not open a public issue for authentication bypasses, credential exposure, tunnel hijacking, request smuggling, SSRF, or executable-installation weaknesses.

Include the affected version or commit, operating system, DeepSeek Harness version, reproduction steps, impact, and any proposed mitigation. Remove API keys, passwords, session cookies, tunnel URLs, usernames, and local network addresses from logs and screenshots.

## Supported versions

Security fixes are provided on the latest release and the default branch until this project publishes a stable compatibility policy.

## Deployment requirements

- Bind the DeepSeek Harness Web server to `127.0.0.1`; otherwise clients may bypass this gateway.
- Use a unique password of at least 10 characters and rotate it after accidental disclosure.
- Keep the tunnel URL private and stop the tunnel when remote access is not required.
- Do not use account-less Quick Tunnels as a production, shared-team, or high-availability access layer.
- Review the pinned `cloudflared` update before changing its version or checksums.

The gateway reduces accidental exposure; it does not sandbox or reduce the authority of DeepSeek Harness after login.
