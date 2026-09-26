# Cloudflare Worker Deployment

Ledger deploys as a Cloudflare Worker with static assets, a D1 database, and Cloudflare Access. The Worker verifies the Access JWT and restricts data to the email configured in `ALLOWED_EMAIL`. Do not deploy this as a static-only Pages site: the local Node server and JSON-file store are for local development only.

## 1. Create D1

From the repository root:

```powershell
npx wrangler login
npm run db:create
```

Create the database named `ledger`. Copy its `database_id` into `wrangler.jsonc`, replacing the all-zero placeholder. If Wrangler offers to update the config, accept and confirm the ID was written.

Apply the schema to the remote database:

```powershell
npm run db:migrate:remote
```

## 2. Connect Workers Builds

In Cloudflare, open **Workers & Pages**, create or select the Worker connected to this repository, then open **Settings > Builds**.

- Worker name: `ledger` (must match `wrangler.jsonc`)
- Repository root directory: `/`
- Production branch: `main` (or the branch you use)
- Build command: leave blank
- Deploy command: `npm run deploy`
- Preview deployments: disable initially so previews cannot use the production D1 database

Workers Builds installs the pinned Wrangler dependency from `package-lock.json`. The prebuilt `web/wasm/budget_tool.wasm` is committed as a static asset; rebuild it locally with `npm run build:wasm` when the Rust calculation changes, then commit the updated asset with the source.

## 3. Require Access

After the Worker exists, in **Workers & Pages > ledger > Access**, select **Protect this Worker behind Access** and apply it to **All traffic**. Use a policy restricted to your Cloudflare account. The Worker's own email allowlist below is an additional single-user restriction.

If you instead create a hostname-based Access application, protect the exact Worker hostname (including `workers.dev`) and use an **Emails** include rule for your personal email. Do not use an unrestricted `Everyone` or broad email-domain policy.

The Worker checks `Cf-Access-Jwt-Assertion` itself. It fails closed if the token is absent/invalid or the Access configuration is missing, even if someone reaches a URL that is not covered by an Access policy.

## 4. Set Worker secrets

Obtain the team domain from your Zero Trust dashboard and the audience tag from the Access application. In the Worker settings, add these as runtime secrets, not build variables:

- `ACCESS_TEAM_DOMAIN`: for example, `your-team.cloudflareaccess.com` (hostname only)
- `ACCESS_AUD`: the Access application's audience tag
- `ALLOWED_EMAIL`: the exact email address allowed to use this personal Ledger

Alternatively, from a logged-in terminal, use `npx wrangler secret put ACCESS_TEAM_DOMAIN`, then repeat for `ACCESS_AUD` and `ALLOWED_EMAIL`; type each value directly into the terminal prompt. Never put these values in Git or `wrangler.jsonc`.

## 5. Import local data once

After the Access-protected Worker is deployed and the D1 migration is applied, import the local JSON store from this machine **before opening Ledger for the first time**. This writes a temporary SQL file in the system temp directory, invokes Wrangler against the remote D1 database, then removes the temporary file. The SQL uses `ON CONFLICT DO NOTHING` so it will not overwrite existing remote Ledger data.

```powershell
$env:LEDGER_EMAIL = "the-same-email-as-ALLOWED_EMAIL"
npm run data:import
Remove-Item Env:LEDGER_EMAIL
```

`.ledger_data.json`, transaction CSVs, history CSVs, Wrangler state, and local secrets are ignored by Git. Confirm `git status` does not list financial data before pushing.

## 6. Deploy

Workers Builds deploys on a push to the configured production branch. You can also deploy from a logged-in terminal with:

```powershell
npm run deploy
```

Open the Worker URL shown by Cloudflare. It should show the Access sign-in flow; after sign-in, the app reads and writes state in D1.