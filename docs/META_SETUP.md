# Instagram / Meta setup

Verified 2026-09-03 against the official Instagram Platform overview, Instagram Login content-publishing guide, insights references and permissions. Meta changes dashboard navigation; use the official Instagram API with Instagram Login onboarding shown for the app, not legacy Instagram Basic Display or an unofficial product.

## Account and app

1. Convert/connect the owner account as an Instagram professional account (Business or Creator). Story availability has additional account/config restrictions; use a Business account when Stories are required and confirm capability in the current docs/account.
2. In [Meta for Developers](https://developers.facebook.com/apps/), create/select the owner’s app and add the Instagram product/configuration that explicitly says **Instagram API with Instagram Login** and supports content publishing.
3. In its API setup/login settings, add the exact OAuth redirect URI:

   `https://YOUR_WORKER_HOST/api/oauth/instagram/callback`

4. Add the final web origin, Privacy Policy, Terms of Use and Data Deletion URLs. Customize the templates before submitting them.
5. Request only:

   - `instagram_business_basic`
   - `instagram_business_content_publish`
   - `instagram_business_manage_insights`

   If deliberately choosing the Facebook Login configuration instead, follow that configuration’s current official permission set (`instagram_basic`, `instagram_content_publish`, `instagram_manage_insights` plus required Page permissions) and adapt the code/configuration; do not mix the two login models.

6. Add the owner as an app role/tester where Meta requires it, complete the invitation in Instagram, and use Postline Connected Accounts to authorize.
7. In App Review → Permissions and Features (or the current equivalent surfaced by the onboarding flow), request the access level required for real accounts. Provide a screencast of login, media choice, caption, publish consent, success/status and deletion/disconnect. Complete business verification if Meta asks.
8. Mark `META_APP_REVIEW_APPROVED=true` only after the dashboard confirms required access for the target account. Switch app mode only according to Meta’s current review guidance.

## Publishing workflow implemented

Postline creates child containers, a carousel parent where needed, polls asynchronous processing and calls `/{ig-user-id}/media_publish`. R2 supplies short-lived fetchable HTTPS media. Feed-image alt text is sent only where the official guide supports it; it is not claimed for Reels/Stories.

## Analytics

The adapter requests media insights through official `/insights` endpoints with `instagram_business_manage_insights` and stores raw names plus normalized values. Meta varies/deprecates metrics by media type and version, so the UI must keep unsupported values unavailable.

## Required live check

With `LIVE_TEST_CONFIRM=true`, publish a single owner-approved item. Confirm container status, media ID/URL and visible content. This repository has not performed that test.

Official sources: [overview](https://developers.facebook.com/docs/instagram-platform/overview), [Instagram Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login), [content publishing](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing), [insights](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/insights), [permissions](https://developers.facebook.com/docs/permissions/).
