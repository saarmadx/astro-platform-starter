import { defineConfig, envField } from 'astro/config';
import netlify from '@astrojs/netlify';

// https://astro.build/config
export default defineConfig({
    output: 'server',
    devToolbar: { enabled: false },
    adapter: netlify(),
    security: { checkOrigin: true },
    env: {
        schema: {
            WHOP_CLIENT_ID: envField.string({ context: 'server', access: 'secret', optional: true }),
            WHOP_CLIENT_SECRET: envField.string({ context: 'server', access: 'secret', optional: true }),
            WHOP_PRODUCT_ID: envField.string({ context: 'server', access: 'secret', optional: true }),
            WHOP_API_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
            WHOP_STORE_URL: envField.string({ context: 'server', access: 'secret', optional: true }),
            WHOP_OAUTH_AUTHORIZE_URL: envField.string({ context: 'server', access: 'secret', optional: true }),
            WHOP_OAUTH_TOKEN_URL: envField.string({ context: 'server', access: 'secret', optional: true }),
            WHOP_OAUTH_USERINFO_URL: envField.string({ context: 'server', access: 'secret', optional: true }),
            WHOP_OAUTH_SCOPES: envField.string({ context: 'server', access: 'secret', optional: true }),
            WHOP_API_BASE: envField.string({ context: 'server', access: 'secret', optional: true }),
            SESSION_SECRET: envField.string({ context: 'server', access: 'secret', optional: true }),
            ADMIN_PASSWORD: envField.string({ context: 'server', access: 'secret', optional: true }),
            DEV_FAKE_USER: envField.string({ context: 'server', access: 'secret', optional: true })
        }
    }
});
