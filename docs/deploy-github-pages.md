# Deploying the web client to GitHub Pages

The client is a fully static site, built to `apps/client/dist`. It uses relative asset paths, so it works at any URL path (e.g. `https://you.github.io/relayllm/`) with no configuration.

## Option A: GitHub Actions (recommended)

1. Push this repository to GitHub.
2. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**.
3. The included workflow `.github/workflows/pages.yml` runs on every push to `main`. It installs dependencies, runs the tests, builds the client, and publishes it.
4. Your client will be at `https://<user>.github.io/<repo>/`. Tell your worker:

   ```bash
   relayllm client-url https://<user>.github.io/<repo>/
   relayllm pair --invite
   ```

## Option B: Manual

```bash
pnpm install
pnpm --filter @relayllm/client build
# publish apps/client/dist to any static host: a gh-pages branch, Netlify, Cloudflare Pages, S3, …
```

## Notes

* **Use your own deployment.** The JavaScript served to your browser holds your unlocked identity, so serve it from a repository you control, and review changes before deploying.
* Pairing links carry the worker npub and relays in the query string, which is visible to the host's access logs. The single-use invite is in the `#fragment`, which browsers don't send to the server. The client removes all pairing parameters from the address bar on load.
* The built `index.html` includes a strict Content-Security-Policy meta tag. There is no telemetry or analytics, and the policy blocks third-party scripts unless you change it in `apps/client/vite.config.ts`.
* A custom domain works like any GitHub Pages site (Settings → Pages → Custom domain).
* There's no server-side component. Any static host works the same way.

## Local preview

```bash
pnpm --filter @relayllm/client build
pnpm --filter @relayllm/client preview     # http://localhost:4173
```
