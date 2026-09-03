# Supabase setup

Verified against current Supabase passwordless-email and RLS documentation on 2026-09-03.

1. In the Supabase dashboard, create a project for this installation and wait for database readiness.
2. Project Settings → API: copy the Project URL and anon/public key. Put those in web build variables. Treat the service-role key as a server-only Worker secret.
3. Install/login/link the CLI and run `supabase db push --dry-run`, inspect the project ref and SQL, then `supabase db push`.
4. Authentication → URL Configuration: set Site URL to the exact HTTPS web origin and add `https://YOUR_WEB_HOST/dashboard` plus the local callback used for development.
5. Authentication → Providers → Email: keep Email enabled. Postline calls `signInWithOtp` with `shouldCreateUser:false`, so the owner must already exist.
6. Authentication → Users: create/invite exactly the owner email. Use the resulting user UUID in the SQL below. Do not enable an application signup screen.
7. SQL Editor, replace both placeholders and run once:

```sql
insert into public.installation_settings (owner_id, owner_email)
values ('OWNER_AUTH_USER_UUID', lower('OWNER_EMAIL'));
```

8. Confirm RLS is enabled for every public table and the migration-created policies exist. Test as the owner and a separate test user; the latter must receive no rows/403.
9. Configure Supabase email delivery for production so magic links are reliable. The built-in test sender is not intended for production volume.

Official sources: [passwordless email](https://supabase.com/docs/guides/auth/auth-email-passwordless), [redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [CLI migrations](https://supabase.com/docs/guides/local-development/cli/getting-started).
