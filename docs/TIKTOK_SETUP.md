# TikTok setup

Verified 2026-09-03 against official TikTok Login Kit, scopes, Direct Post, media-transfer and sharing-guideline documentation.

1. In [TikTok for Developers](https://developers.tiktok.com/apps/), register/select the owner’s app.
2. Add **Login Kit** and **Content Posting API** products. Enable the Direct Post configuration in the Content Posting API section.
3. Configure the web redirect URI exactly:

   `https://YOUR_WORKER_HOST/api/oauth/tiktok/callback`

4. Add the final Privacy Policy, Terms of Use and Data Deletion URLs and the web domain required by the dashboard.
5. Request/enable `user.info.basic` and seek approval for `video.publish`. Postline additionally requests `user.info.profile`, `user.info.stats` and `video.list` to display profile/analytics. Remove optional scopes in code if those analytics are not needed.
6. For photo posts or `PULL_FROM_URL`, open the app’s URL properties area and verify the exact HTTPS media domain or URL prefix. TikTok recommends DNS verification for a domain. The URL must not redirect and must remain accessible during the fetch.
7. Submit for review with the Content Sharing Guidelines user experience: query/display current creator info, let the owner choose only returned privacy options, show interaction controls, require explicit consent, disclose commercial/own-brand/branded and AI-generated status, and avoid watermarks/promotional overlays.
8. Test the integration only under TikTok’s permitted unaudited conditions. Then apply for the required audit to lift private-only restriction. Set `TIKTOK_CONTENT_POSTING_AUDITED=true` only when TikTok confirms it.

## Hard safety rule

TikTok documents that unaudited Direct Post clients are restricted to private viewing. Postline does **not** silently replace `PUBLIC_TO_EVERYONE` with `SELF_ONLY`; public scheduling remains blocked. There is no manual-post fallback.

## Media and rate notes

The adapter uses `/v2/post/publish/creator_info/query/`, video or photo init, sequential file chunks for video, and `/v2/post/publish/status/fetch/`. Official docs specify 5–64 MB normal chunks (with special final/small-file rules), maximum 1000 chunks, video up to 4 GB, and current image limits in the support matrix. Direct Post init is documented with a per-user request rate, and sharing guidelines impose a creator 24-hour posting cap; these external limits still apply.

Official sources: [Direct Post start](https://developers.tiktok.com/docs/en/content-posting-api-get-started), [reference](https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post), [media transfer](https://developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide), [scopes](https://developers.tiktok.com/docs/en/tiktok-api-scopes), [sharing guidelines](https://developers.tiktok.com/docs/en/content-sharing-guidelines), [user tokens](https://developers.tiktok.com/doc/oauth-user-access-token-management).
