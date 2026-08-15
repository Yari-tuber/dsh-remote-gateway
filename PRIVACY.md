# Privacy

DSH Remote Gateway contains no analytics, advertising, crash reporting, or project telemetry.

The plugin processes login credentials locally. Session tokens, failed-login counters, temporary bans, and generated passwords remain in Harness process memory and are discarded at shutdown. A configured password may exist in the user's local Harness profile patch; the plugin does not upload it.

Starting a Quick Tunnel connects `cloudflared` to Cloudflare. Cloudflare necessarily receives network metadata and relays encrypted browser traffic according to its own terms and privacy policy. Managed installation downloads a pinned release asset from GitHub Releases, so GitHub receives the normal download request metadata.

The settings page lists network interface addresses detected on the local computer. These addresses are returned only through the local Harness control API and are not sent by this plugin to its maintainers.

Do not include credentials, temporary tunnel URLs, session cookies, usernames, local paths, or network addresses in public issues.
