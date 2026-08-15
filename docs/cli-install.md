# CLI installation

This tutorial installs DSH Remote Gateway into the DeepSeek Harness `web` profile and ends with a verified authenticated gateway.

## Prerequisites

Confirm that `dsh`, Node.js, and pnpm are available:

```powershell
dsh --version
node --version
pnpm --version
```

DeepSeek Harness must support `dsh plugin --profile`, profile bundles, and the Web server service described in the root README.

## Install from GitHub

```powershell
dsh plugin --profile web add github:Yari-tuber/dsh-remote-gateway
```

If pnpm blocks the Git dependency's `prepare` script, open the exact `pnpm-workspace.yaml` path printed by Harness and add:

```yaml
allowBuilds:
  dsh-remote-gateway: true
```

Run the same install command again. Do not enable unrelated dependency scripts.

## Install from a local checkout

```powershell
git clone https://github.com/Yari-tuber/dsh-remote-gateway.git
cd dsh-remote-gateway
pnpm install --frozen-lockfile
pnpm run prepare
dsh plugin --profile web add .
```

A local checkout installation does not require `allowBuilds` because the bundle is built before it is added.

## Start and configure

```powershell
dsh --profile web
```

Open the local Harness URL printed in the terminal, then go to **Settings → Remote Access**.

1. Set a unique username and a password of at least 10 characters.
2. Keep the Harness core listener on `127.0.0.1`.
3. Select **Set up and start**.
4. Wait for the environment state to become **Ready** and for an HTTPS address to appear.
5. Open that address in the phone browser, sign in, and confirm that the Harness interface loads and remains connected.

The first managed setup downloads and verifies `cloudflared`. Later starts reuse the verified installation.

## Persistent configuration

Settings-page edits apply to the running process. To preserve deployment values across restarts, replace the complete bundle config in `~/.dsh/profiles/web/cordis.patch.yml`. Copy the defaults from the root [`cordis.patch.yml`](../cordis.patch.yml), then change only the intended values.

Avoid storing a password in a shared repository. An empty password generates a new strong password at each boot and displays it only in the local settings page.

## Update

```powershell
dsh plugin --profile web update dsh-remote-gateway
```

Restart Harness after an update so Host and browser bundles reload together.

## Remove

Stop the public tunnel in settings, stop Harness, then run:

```powershell
dsh plugin --profile web remove dsh-remote-gateway
```

The verified managed executable remains under `$DSH_HOME/tools/dsh-remote-gateway` for explicit manual cleanup. It contains no login credentials or session data.

## Troubleshooting

**The Remote Access page is missing:** confirm `dsh-remote-gateway` appears in the `dsh.profile.bundles` list in the web profile manifest, then restart Harness.

**Installation reports `allowBuilds`:** add only `dsh-remote-gateway: true` to the profile's `pnpm-workspace.yaml`, then rerun the install.

**The tunnel does not start:** use **Detect again**, check outbound HTTPS access to GitHub and Cloudflare, and try `tunnelProtocol: http2` when UDP/QUIC is filtered.

**The phone sees the login page but Harness disconnects:** update both the Host and client bundle together and confirm the installed Harness exposes the supported WebSocket event paths.

**A warning says the core is not loopback-bound:** stop remote access and bind the Harness Web server to `127.0.0.1` before continuing.
