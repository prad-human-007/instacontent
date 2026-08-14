# Instacontent

Next.js application deployed to the `instacontent` Cloudflare Worker through
OpenNext. The `/modi` tool generates an H.264/AAC MP4 with WebCodecs and
Mediabunny, publishes completed exports as Instagram Reels, and can run the
same workflow unattended through Cloudflare Browser Run and a Cron Trigger.

## Environment model

Instagram credentials are server-only. They are never read by client code and
must never use a `NEXT_PUBLIC_` prefix.

- Local `next dev`: Next.js automatically loads `.env.development.local` into
  `process.env`. OpenNext supplies the R2 binding through
  `getCloudflareContext().env`.
- Production: the server reads Worker secrets, variables, and bindings at
  request time from `getCloudflareContext().env`.
- `.env.development.local`, `.env.local`, `.dev.vars`, and other real
  environment files are ignored by Git. `.env.example` is tracked.
- `next.config.ts` already calls `initOpenNextCloudflareForDev()` once. Wrangler
  4.113 supports the stable `remote: true` R2 binding, so no experimental
  OpenNext option is needed.

Copy the placeholders from `.env.example` into `.env.development.local` and
manually fill:

```env
INSTAGRAM_ACCESS_TOKEN=<Instagram User access token>
INSTAGRAM_ACCOUNT_ID=<Instagram-scoped professional account ID>
INSTAGRAM_MEDIA_PUBLIC_BASE_URL=https://<public R2 custom domain>
INSTAGRAM_GRAPH_API_VERSION=v25.0
INSTACONTENT_PUBLIC_BASE_URL=https://<deployed-app-hostname>
```

The Cloudflare Access values may stay empty during `npm run dev`; authorization
has a bypass only when `NODE_ENV` is exactly `development` and the request
hostname is localhost:

```env
CLOUDFLARE_ACCESS_TEAM_DOMAIN=https://<team-name>.cloudflareaccess.com
CLOUDFLARE_ACCESS_AUD=<Access application AUD tag>
INSTAGRAM_PUBLISH_ADMIN_EMAILS=<admin@example.com,second-admin@example.com>
CLOUDFLARE_ACCESS_SERVICE_CLIENT_ID=<Access-service-token-client-id>
CLOUDFLARE_ACCESS_SERVICE_CLIENT_SECRET=<Access-service-token-client-secret>
INSTAGRAM_AUTOMATION_SIGNING_KEY=<random-32-plus-character-secret>
INSTAGRAM_TOKEN_ENCRYPTION_KEY=<base64-encoded-32-byte-key>
```

Never copy production secrets out of Cloudflare merely to deploy. The existing
`INSTAGRAM_ACCESS_TOKEN` and `INSTAGRAM_ACCOUNT_ID` Worker secrets are preserved
by deployment and read only at runtime.

## Required R2 setup

The committed Wrangler binding is:

```json
{
  "binding": "INSTAGRAM_MEDIA",
  "bucket_name": "instacontent-instagram-media",
  "remote": true
}
```

Complete these dashboard steps before publishing:

1. Open **Cloudflare Dashboard → R2 Object Storage → Create bucket**.
2. Name it `instacontent-instagram-media`.
3. Open the bucket, then **Settings → Public access → Custom Domains →
   Connect Domain**. Use a dedicated hostname such as a media subdomain you
   control. A custom domain is recommended for production.
4. For temporary development only, **Public access → R2.dev subdomain →
   Enable** is also usable. Do not treat `r2.dev` as the production option.
5. Put the resulting HTTPS origin, without an object path, into
   `INSTAGRAM_MEDIA_PUBLIC_BASE_URL`. Do not add a guessed URL.
6. Open **Settings → Object lifecycle rules → Add rule**. Name it
   `delete-temporary-instagram-media`, scope it to prefix
   `temporary-instagram-media/`, and expire objects after 1 day.
7. Deploy from this directory. Wrangler binds the bucket to the Worker as
   `INSTAGRAM_MEDIA`. If binding manually instead, use
   **Workers & Pages → instacontent → Settings → Bindings → Add → R2 bucket**,
   choose the same bucket, and enter the exact variable name
   `INSTAGRAM_MEDIA`.

The lifecycle prefix intentionally excludes `internal-publication-state/`.
Those small records provide durable duplicate-publication protection.

`remote: true` is intentional and documented: `npm run dev` uploads through the
binding to the real bucket. Meta cannot fetch a local R2 emulator. Local
publishing therefore requires Wrangler authentication, the remote bucket, and
the public HTTPS R2/custom-domain URL. Ordinary video generation still happens
entirely in the browser.

## Required production variables

In **Workers & Pages → instacontent → Settings → Variables and Secrets**, keep
the two existing secrets and add these non-secret runtime variables:

```text
INSTAGRAM_MEDIA_PUBLIC_BASE_URL=https://<your configured R2 hostname>
INSTAGRAM_GRAPH_API_VERSION=v25.0
CLOUDFLARE_ACCESS_TEAM_DOMAIN=https://<team-name>.cloudflareaccess.com
CLOUDFLARE_ACCESS_AUD=<Access application AUD tag>
INSTAGRAM_PUBLISH_ADMIN_EMAILS=<comma-separated authorized emails>
INSTACONTENT_PUBLIC_BASE_URL=https://<deployed-app-hostname>
```

Add these as Worker secrets, never plain variables:

```text
INSTAGRAM_AUTOMATION_SIGNING_KEY
INSTAGRAM_TOKEN_ENCRYPTION_KEY
CLOUDFLARE_ACCESS_SERVICE_CLIENT_ID
CLOUDFLARE_ACCESS_SERVICE_CLIENT_SECRET
```

`INSTAGRAM_TOKEN_ENCRYPTION_KEY` must decode to exactly 32 bytes. Start
automation with a freshly issued long-lived Instagram token; the Worker
encrypts its managed copy in R2 and attempts refresh after 30 days.

`keep_vars: true` in `wrangler.jsonc` prevents dashboard-managed non-secret
variables from being removed by a deploy.

The implementation uses the current Instagram API with Instagram Login host,
`graph.instagram.com`, and sends an Instagram User access token as a Bearer
token. It creates a `REELS` container with `share_to_feed=true`, polls the
container with bounded exponential backoff, then calls `media_publish`.

## Required Cloudflare Access setup

Production publishing stays disabled unless a signed Cloudflare Access JWT is
valid and its email is in `INSTAGRAM_PUBLISH_ADMIN_EMAILS`.

1. Open **Cloudflare Zero Trust → Access controls → Applications**.
2. Add a **Self-hosted** application for the deployed app hostname. Protect the
   whole admin app or at minimum the path `/api/instagram/publish`.
3. Add an **Allow** policy restricted to the administrator email or identity
   group.
4. Open the application’s additional settings and copy its
   **Application Audience (AUD) Tag** into `CLOUDFLARE_ACCESS_AUD`.
5. Put the team issuer origin
   `https://<team-name>.cloudflareaccess.com` into
   `CLOUDFLARE_ACCESS_TEAM_DOMAIN`.
6. Put the same allowed administrator email address(es) into
   `INSTAGRAM_PUBLISH_ADMIN_EMAILS`.

The route validates the JWT signature against Cloudflare’s rotating JWKS, plus
issuer, audience, expiry, not-before time, and administrator email. Merely
supplying an Access-looking header is not accepted.

## Required automation setup

1. In **Zero Trust → Access controls → Service credentials**, create a service
   token dedicated to `instacontent` automation.
2. Add a Service Auth policy to the existing Access application that allows
   this service token to open the deployed `/modi` page and its API routes.
3. Save the client ID and secret as the Worker secrets shown above.
4. Set `INSTACONTENT_PUBLIC_BASE_URL` to the deployed HTTPS origin, without a
   path, query, credentials, or fragment.
5. Deploy the custom OpenNext Worker. `wrangler.jsonc` supplies the `BROWSER`
   binding and a once-per-minute Cron Trigger. The trigger launches a browser
   only when a saved local time is due or a Run now/check job is queued.
6. Open `/modi`, select dates/audio, click **Check renderer**, and wait for
   WebCodecs to show **Ready**.
7. Choose time/timezone, enable automation, then click **Save schedule**.

The Cloudflare account must have Browser Rendering enabled and enough browser
session, Worker CPU, and Cron capacity for the generated Reel duration.

The automated browser receives a per-run HMAC signature only on same-origin
requests. Access service credentials and the signature are not sent to other
origins. R2 daily locks prevent Cron retries and Run now from publishing twice
on the same local date.

## Publishing safety

- The final MP4 is uploaded only after successful browser generation.
- Server accepts only MP4 files with an MP4 `ftyp` header, up to 64 MB, and
  captions from 1 to 2,200 characters.
- Public media object keys use `crypto.randomUUID()` and cannot be selected by
  the browser.
- The public media URL comes only from server configuration.
- A SHA-256 export identity plus an atomic R2 conditional write blocks double
  clicks, concurrent calls, and retries from publishing the same export twice.
- Temporary video remains available for Meta processing; lifecycle cleanup
  happens later.
- Tokens, Authorization headers, and complete Meta responses are never returned
  or logged. Client errors contain sanitized codes/messages.

## Commands

Run these yourself from `frontend/` when ready:

```bash
# Local Next.js development
npm run dev

# Refresh Cloudflare binding declarations after config changes
npm run cf-typegen

# Optional checks
npx tsc --noEmit
npm run lint
npm run build

# Deploy the OpenNext Worker
npm run deploy
```

`npm run deploy` installs the Cron Trigger but does not publish immediately.
The first automatic post happens at the saved schedule or after confirming
**Run now (real post)** on `/modi`.

## First manual Reel test

1. Finish the R2 public-domain, lifecycle, binding, runtime-variable, and
   Cloudflare Access setup above.
2. Confirm `@pmmodiprogressbar` is a professional account, the token belongs to
   that Instagram Login account, and the Meta app has
   `instagram_business_content_publish`.
3. For local testing, fill `.env.development.local`, authenticate Wrangler, and
   run `npm run dev`.
4. Open `/modi`, select dates/audio, then click **Generate Video**.
5. Wait for **Video ready**. Review the downloaded MP4 before continuing.
6. Review or edit the generated caption.
7. Click **Post to Instagram** once. Leave the page open through Uploading,
   Preparing, Instagram processing, and Publishing.
8. Confirm the success message and media ID, then verify the Reel in
   `@pmmodiprogressbar`.
9. If the UI says the publication outcome is unknown, check Instagram before
   doing anything else. Do not retry blindly.
