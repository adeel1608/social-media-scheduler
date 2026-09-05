# Supabase setup

Verified against current Supabase passwordless-email, SMTP, abuse-prevention,
local-development, database-testing, and RLS documentation on 2026-09-05.

1. In the Supabase dashboard, create a project for this installation and wait
   for database readiness.
2. Project Settings > API: copy the Project URL and anon/public key. Put those
   in web build variables. Treat the service-role key as a server-only Worker
   secret.
3. Install/login/link the CLI and run `supabase db push --dry-run`, inspect the
   project ref and SQL, then `supabase db push`.
   Before pushing, execute every migration and the pgTAP authorization checks
   against a disposable local stack:

   ```bash
   corepack pnpm exec supabase start
   corepack pnpm db:test
   corepack pnpm exec supabase stop --no-backup
   ```

   CI runs the same disposable-stack verification. The production deployment
   workflow also makes a zero-row, non-mutating service-role call to
   `claim_stale_targets`, a zero-row notification-schema query, and the
   `verify_phase_2b_schema` preflight for durable disconnect recovery; it stops
   before Worker deployment if any required migration is missing or
   inaccessible.

4. Authentication > URL Configuration: set Site URL to the exact HTTPS web
   origin and add `https://YOUR_WEB_HOST/dashboard` plus the local callback used
   for development.
5. Authentication > Providers > Email: keep Email enabled, disable **Allow new
   users to sign up**, and set the minimum interval between email requests to at
   least 60 seconds. Postline also calls `signInWithOtp` with
   `shouldCreateUser:false`, but the project-level setting is the direct Auth
   API control and must remain disabled after the owner is created.
6. Authentication > Users: create/invite exactly the owner email. Use the
   resulting user UUID in the SQL below. Do not enable an application signup
   screen.
7. In SQL Editor, replace both placeholders and run once:

```sql
insert into public.installation_settings (owner_id, owner_email)
values ('OWNER_AUTH_USER_UUID', lower('OWNER_EMAIL'));
```

8. Confirm RLS is enabled for every public table and the migration-created
   policies exist. Test as the owner and a separate test user; the latter must
   receive no rows/403.
9. Configure Supabase Auth email delivery so magic links are reliable. The
   built-in test sender is not intended for production use. For the no-domain
   single-owner Gmail path, use `smtp.gmail.com`, SSL port `465`, the owner Gmail
   address as sender and username, and a dedicated Google App Password created
   after enabling 2-Step Verification. Enter that password only in Supabase.
   Never commit, log, display, or place it in a frontend variable. This is
   low-volume owner authentication and may deliver less reliably than a
   dedicated transactional provider. Clone owners must use their own SMTP
   service and credentials. See [EMAIL_SETUP.md](EMAIL_SETUP.md).
10. In Cloudflare Dashboard → Turnstile → Add widget, create a managed widget
    restricted to the exact production Pages/custom hostname. Then open
    Supabase Dashboard → Settings → Authentication → Bot and Abuse Protection,
    enable CAPTCHA protection, select Cloudflare Turnstile, and paste the
    Turnstile secret key. Put only the public Site Key in the production GitHub
    environment variable `VITE_TURNSTILE_SITE_KEY`. The login sends the returned
    browser token to `signInWithOtp`; the Turnstile secret belongs only in
    Supabase and must never be a `VITE_` value.

Worker failed-post notification is separate from Supabase Auth SMTP and uses
Resend. Configuring one does not configure the other.

Official sources: [passwordless email](https://supabase.com/docs/guides/auth/auth-email-passwordless), [production checklist](https://supabase.com/docs/guides/deployment/going-into-prod), [custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp), [Gmail SMTP](https://supabase.com/docs/guides/troubleshooting/using-google-smtp-with-supabase-custom-smtp-ZZzU4Y), [Supabase CAPTCHA](https://supabase.com/docs/guides/auth/auth-captcha), [Cloudflare Turnstile widget configuration](https://developers.cloudflare.com/turnstile/get-started/widget-management/dashboard/), [redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), and [CLI migrations](https://supabase.com/docs/guides/local-development/cli/getting-started).
