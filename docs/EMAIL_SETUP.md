# Resend failure-email setup

Verified against current Resend domain documentation on 2026-09-03.

1. Create a Resend account and open Domains → Add Domain. A sending subdomain such as `alerts.example.com` keeps reputation separate.
2. Copy the exact SPF and DKIM records Resend displays to the DNS provider. Add DMARC if appropriate. Return to the domain and verify until its status is `verified`.
3. API Keys → Create API Key. Restrict it to sending access and the selected domain when the dashboard offers that scope. After the Worker exists, copy it once into the hidden `wrangler versions secret put RESEND_API_KEY` prompt so the resulting Worker version remains undeployed until review. The unversioned `wrangler secret put` command deploys immediately.
4. Set `RESEND_FROM` to a display name/address on exactly the verified domain, for example `Postline Alerts <postline@alerts.example.com>`.
5. Set `NOTIFICATION_EMAIL` to the owner’s monitored inbox.
6. Cause a safe pre-publication failure in a controlled environment. Confirm one message, then deliver the same deduplication key again and confirm no second send.

Emails contain a post identifier/title, platform, scheduled/failure time, safe error, definite/ambiguous status, dashboard link and manual-retry guidance. They never contain tokens, raw provider responses or signed URLs. There are no success emails.

Official sources: [domain verification](https://resend.com/docs/dashboard/domains/introduction), [sending an email](https://resend.com/docs/api-reference/emails/send-email), [sender addresses](https://resend.com/docs/knowledge-base/how-do-I-create-an-email-address-or-sender-in-resend).
