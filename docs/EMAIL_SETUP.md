# Email delivery setup

Verified against current Supabase, Google Account, and Resend documentation on
2026-09-04.

Postline has two independent email paths:

- **Supabase Auth email** sends the owner magic links used to sign in. Configure
  it in Supabase; it does not use the Worker's Resend key.
- **Worker failure notifications** report `failed` and `needs_review` publish
  results. Configure them with Resend; they never send login links or success
  messages.

## Supabase Auth with an owner Gmail account

For a no-domain, low-volume single-owner installation, Supabase can use the
owner's Gmail SMTP account. Enable 2-Step Verification on the Google Account,
create a dedicated App Password, then enter these values only in Supabase Auth
SMTP settings:

- host: `smtp.gmail.com`
- port: `465`
- encryption: SSL
- username and sender email: the owner Gmail address
- password: the dedicated Google App Password
- minimum email interval: 60 seconds

Never commit, log, display, or place the App Password in a frontend or `VITE_`
variable. Google can revoke App Passwords after an account-password change.
Google does not generally recommend App Passwords; use this narrowly because
SMTP cannot use the normal Sign in with Google flow.
This route is suitable only for low-volume owner authentication and may have
weaker transactional-email deliverability than a dedicated SMTP provider.
Every clone owner must supply and protect their own SMTP account and
credentials; the upstream maintainer's settings are not shared.

## Resend Worker notifications

1. Create a Resend account and open Domains > Add Domain. A sending subdomain
   such as `alerts.example.com` keeps reputation separate.
2. Copy the exact SPF and DKIM records Resend displays to the DNS provider. Add
   DMARC if appropriate. Return to the domain and verify until its status is
   `verified`.
3. Open API Keys > Create API Key. Restrict it to sending access and the
   selected domain when the dashboard offers that scope. After the Worker
   exists, copy it once into the hidden
   `wrangler versions secret put RESEND_API_KEY` prompt so the resulting Worker
   version remains undeployed until review. The unversioned
   `wrangler secret put` command deploys immediately.
4. Set `RESEND_FROM` to a display name/address on exactly the verified domain,
   for example `Postline Alerts <postline@alerts.example.com>`.
5. Set `NOTIFICATION_EMAIL` to the owner's monitored inbox.
6. Cause a safe pre-publication failure in a controlled environment. Confirm
   one message, then deliver the same deduplication key again and confirm no
   second send.

If the installation has no domain, Resend officially permits the
`onboarding@resend.dev` test sender to deliver only to the email address
associated with that Resend account. That is a narrowly scoped development or
owner-only evaluation path: it cannot send to any other recipient, is not a
general production sender, and does not establish custom-domain deliverability.
It is usable here only when `NOTIFICATION_EMAIL` is exactly the Resend account
owner's address and the owner deliberately accepts those limitations. Otherwise
failure notification remains blocked until a domain is verified or another
suitable sender is configured. Postline does not configure either option
automatically.

The Worker preflight also requires the test-sender recipient to equal
`OWNER_EMAIL`. That enforces Postline's single-owner boundary, but it cannot
prove which address owns the external Resend account; the human installer must
still verify that exact match in Resend.

Emails contain a post identifier/title, platform, scheduled/failure time, safe
error, definite/ambiguous status, dashboard link, and manual-retry guidance.
They never contain tokens, raw provider responses, or signed URLs. There are no
success emails.

Official sources: [Supabase custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp), [Supabase Gmail SMTP](https://supabase.com/docs/guides/troubleshooting/using-google-smtp-with-supabase-custom-smtp-ZZzU4Y), [Google App Passwords](https://support.google.com/accounts/answer/185833), [Resend test-domain restriction](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain), [domain verification](https://resend.com/docs/dashboard/domains/introduction), [sending an email](https://resend.com/docs/api-reference/emails/send-email), and [sender addresses](https://resend.com/docs/knowledge-base/how-do-I-create-an-email-address-or-sender-in-resend).
