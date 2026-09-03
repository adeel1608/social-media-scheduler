# YouTube setup

Verified 2026-09-03 against official Google OAuth, YouTube Data API, upload, thumbnail and Analytics API documentation.

1. In [Google Cloud Console](https://console.cloud.google.com/), create/select the owner’s project.
2. APIs & Services → Library: enable **YouTube Data API v3** and **YouTube Analytics API**.
3. Google Auth Platform → Branding: configure app name, support email, homepage, customized Privacy Policy, Terms and Data Deletion URLs. Complete the required domain verification.
4. Audience: select the appropriate internal/external audience. Add the owner as a test user while the consent screen is in testing.
5. Data Access: configure/request only:

   - `openid`, `email`
   - `https://www.googleapis.com/auth/youtube.upload`
   - `https://www.googleapis.com/auth/youtube.readonly`
   - `https://www.googleapis.com/auth/yt-analytics.readonly`

   Postline does not request monetary or content-owner scopes by default.

6. Clients → Create Client → Web application. Add the exact redirect URI:

   `https://YOUR_WORKER_HOST/api/oauth/youtube/callback`

7. Store client ID/server secret as Worker secrets. Connect from Postline and consent using the account that owns the intended channel.
8. Submit OAuth verification if required for these sensitive/restricted scopes. Separately follow the audit link in the official `videos.insert` documentation for public upload eligibility. Set `YOUTUBE_API_AUDIT_APPROVED=true` only after confirmation.

## Public visibility restriction

Google documents that videos uploaded through `videos.insert` from unverified API projects created after 28 July 2020 are restricted to private. Postline blocks a requested public upload while its audit flag is false instead of reporting a private upload as success.

## Upload and Short behavior

The Worker initializes a resumable `videos.insert` session and streams validated UploadThing byte ranges across queue continuations. It verifies upstream status and `Content-Range` and never holds the entire video in memory. A Short uses the same endpoint; YouTube determines classification from current Shorts eligibility. Optional JPEG/PNG thumbnails stream from the validated provider URL to `thumbnails.set` after a video ID exists and must meet the documented 2 MB limit/channel permission.

## Analytics

The adapter queries `youtubeanalytics.googleapis.com/v2/reports` and stores raw metric names. Report combinations and recent-day availability vary. Content-owner/revenue reports require additional status/scopes and are intentionally excluded.

Official sources: [Data API](https://developers.google.com/youtube/v3), [`videos.insert`](https://developers.google.com/youtube/v3/docs/videos/insert), [resumable uploads](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol), [`thumbnails.set`](https://developers.google.com/youtube/v3/docs/thumbnails/set), [server OAuth](https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps), [Analytics reports](https://developers.google.com/youtube/analytics/reference/reports/query).
