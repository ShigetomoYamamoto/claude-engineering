# Deploy contract: Cloudflare Workers (static assets, no DB)

<!--
Copy this file to `.claude/deploy.md` in the project and fill every <placeholder>.
`deploy-runner` reads it in Phase 1 and follows it. Keep real secrets OUT of this file.
Account IDs are not secrets, but do not commit them to a public repository: name a
`target` instead and keep the ID in `~/.config/claude-deploy/cloudflare.json`.
-->

- platform: cloudflare-workers-static
- worker_name: <worker-name>                 # must equal `name` in wrangler.jsonc
- assets_dir: <assets-dir>                   # must equal `assets.directory` in wrangler.jsonc
- build_command: <build command, or "none">  # run before deploy; "none" for hand-written static files
- target: <target-name>                      # key under "targets" in ~/.config/claude-deploy/cloudflare.json (e.g. work)
- account_id_source: target                  # target = read from the user-level file above; env = CLOUDFLARE_ACCOUNT_ID already set
- keychain_service: from-target              # from-target = use the target's value; or a literal macOS Keychain service name
- no_db: true                                # declaration: no database, no migrations, no D1/KV/R2/Durable Objects bindings
- asset_check: all                           # optional, default all. all = the referenced files plus every other non-HTML file under assets_dir (lazy chunks included); referenced = only files linked from the smoke-check pages

## Smoke checks

Run after deploy against the `*.workers.dev` URL inside the verify window: the first round about 10 s after the
deploy returns, retried until every check passes, with a hard deadline of 90 s (details: `deploy-runner` agent,
Cloudflare Workers step 4). Every smoke check and every asset URL must pass in the same round. Write paths in
canonical form (`/about`, `/docs/`; not `/about.html` or `/docs`): redirects are not followed, so a path that
redirects never passes. The expected text must also exist in the previous version, because the same smoke checks
run after an automatic rollback.

| path | expected text |
|------|---------------|
| /    | <text that must appear on the page> |

## Rollback

- method: wrangler-version-rollback   # record the active version id before deploy; on failure `wrangler rollback <id>`
- first_deploy: report-failure        # no previous version exists: report the failure, keep the new Worker (no users yet)
