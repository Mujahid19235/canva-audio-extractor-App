# Audio Extractor — Canva Apps Marketplace Submission Guide

## 1. Product Summary

**Audio Extractor** is a focused utility app for Canva that extracts MP3 audio from a video and makes it available in Canva:
- **Canvas video**: Uses `@canva/app-hooks` (`useSelection("video")`) and `@canva/asset` (`getTemporaryUrl({ type: "video", ref })`) to read the selected video on the canvas.
- **Device video**: Uses `@canva/app-ui-kit`'s `<FileInput>` to accept a local video file (up to 250 MB).
- **Extraction**: Uses an isolated Node.js/Express backend with `ffmpeg-static` and `ffprobe-static` to validate the video, verify an audio stream exists, extract MP3 audio (`audio/mpeg`), and host the temporary file over HTTPS for Canva's `upload()` API.
- **Upload & Timeline Insertion**: Uses `@canva/asset` (`upload({ type: "audio", ... })`) and `@canva/design` (`addAudioTrack({ ref })`), gated by `useFeatureSupport()` (`isSupported(addAudioTrack)`). When automatic insertion is unsupported (e.g., Canva Docs or Whiteboards), the audio is still uploaded to the user's Canva media library and the user is informed to add it manually from Uploads.

## 2. Known SDK Limitation (Media Library Picker)

The Canva Apps SDK does **not** currently expose a native media-library picker modal for browsing existing user-uploaded videos directly from an app. As a result, **Audio Extractor** uses the official Selection API (`useSelection("video")`) for videos placed on the Canva canvas, paired with `<FileInput>` for local device videos.

## 3. Required Canva Developer Portal Permissions

Enable the following scopes in **Canva Developer Portal → Your App → Permissions**:
- `canva:design:content:read` (read selected video on canvas)
- `canva:design:content:write` (insert extracted audio track via `addAudioTrack`)
- `canva:asset:private:read` (retrieve temporary download URL via `getTemporaryUrl`)
- `canva:asset:private:write` (upload extracted MP3 via `upload`)

## 4. Environment & Hosting Requirements

Canva's `upload({ type: "audio", url, ... })` API requires `url` to be:
- Publicly accessible over **HTTPS** (no `localhost`, no IP addresses, no redirects)
- Returning HTTP `200` with `Content-Type: audio/mpeg`

Before running `npm run build` for Marketplace submission:
1. Deploy `backend/server.ts` to a public HTTPS host (e.g., `https://audio-extractor-api.example.com`).
2. Set `CANVA_BACKEND_HOST=https://audio-extractor-api.example.com` and `CANVA_APP_ID=<your-app-id>` in `.env`.
3. Run `npm run build` to generate the production bundle in `dist/`.
4. Upload `dist/` in the Canva Developer Portal.

## 5. Marketplace Review Checklist

- [ ] App name set to **Audio Extractor** in Canva Developer Portal
- [ ] All 4 required scopes enabled (`canva:design:content:read`, `canva:design:content:write`, `canva:asset:private:read`, `canva:asset:private:write`)
- [ ] Production HTTPS backend deployed and `CANVA_BACKEND_HOST` updated before `npm run build`
- [ ] `CANVA_APP_ID` configured on the backend for Canva JWT verification (`@canva/app-middleware/express`)
- [ ] Tested in both Light and Dark themes inside Canva Editor (handled automatically by `@canva/app-ui-kit`)
- [ ] Tested in a supported design type (e.g., Presentation / Video) and an unsupported design type (e.g., Canva Doc)
- [ ] App icon, featured graphics, and marketplace listing description prepared (without external links in description)
- [ ] Reviewer test instructions provided (no separate login required; test with any video on canvas or local MP4)
