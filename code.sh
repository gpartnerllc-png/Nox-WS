cd repo
npm install
npx wrangler login
npx wrangler d1 migrations apply noxmob-db --remote -c worker/wrangler.toml
npx wrangler secret put ZERNIO_API_KEY -c worker/wrangler.toml
npx wrangler deploy -c worker/wrangler.toml
