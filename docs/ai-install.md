# AI-assisted installation

Use the following prompt with a coding agent that has terminal access to the computer running DeepSeek Harness.

```text
Install the public GitHub bundle github:Yari-tuber/dsh-remote-gateway into the existing DeepSeek Harness web profile.

Safety requirements:
- Preserve all existing Harness profiles, settings, credentials, sessions, and unrelated plugins.
- Never print, copy, commit, or upload API keys, passwords, cookies, tunnel URLs, usernames, local paths, or network addresses.
- Do not bind the main Harness Web server to 0.0.0.0, ::, a LAN address, or a public address. It must remain on 127.0.0.1 so the authenticated gateway cannot be bypassed.
- Do not enable build scripts for unrelated dependencies.
- Do not create a GitHub repository, commit, or push anything.

Procedure:
1. Verify that dsh, Node.js ^22.19 or >=24, and pnpm are available.
2. Run: dsh plugin --profile web add github:Yari-tuber/dsh-remote-gateway
3. If pnpm blocks the Git dependency prepare script, edit only the exact web-profile pnpm-workspace.yaml path printed by Harness and add:
   allowBuilds:
     dsh-remote-gateway: true
   Then rerun the same install command.
4. Confirm that the web profile manifest lists dsh-remote-gateway in dsh.profile.bundles.
5. Start dsh --profile web and wait for the local URL. Do not expose it on a non-loopback interface.
6. Confirm that Settings contains Remote Access and that its environment status can be loaded. Do not start a public tunnel unless I explicitly ask you to do so.
7. Report only the commands run, non-sensitive pass/fail results, and any action I must complete in the UI.
```

After the agent finishes, open **Settings → Remote Access** yourself, set a unique password, and select **Set up and start**. This keeps the credential out of the agent transcript.
