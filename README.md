# Burst Recording Service

A local TikTok livestream recorder with a black, animated web interface. Type a
TikTok username, Burst checks whether they are live, and if they are it records
the stream as a vertical **9:16 1080 × 1920** video straight to this PC. Finished
recordings are collected in a searchable library where deletion is protected by a
code.

The recorder can run locally or on a hosted Node.js server. When hosted, recordings are stored on the server and require persistent disk storage.

---

## Requirements

- Windows 10/11 (the launcher is a `.bat` file; the server itself also runs on
  macOS/Linux)
- [Node.js](https://nodejs.org/) 20 or newer
- An internet connection to reach TikTok
- Roughly 1 GB of free disk space minimum (the server refuses to start a
  recording below this)

`ffmpeg` is installed automatically through the `ffmpeg-static` npm package, so
there is nothing else to install.

## Start it

Double-click **`start.bat`**.

On first run it installs dependencies (this can take a minute), then opens
`http://localhost:3000` in your browser and starts the server. Keep the console
window open while recording.

Manual start:

```bash
npm install
npm start
```

Then open <http://127.0.0.1:3000>.


## Public website access

This build has **no site-wide password, access key, or login screen**. Anyone who has the public website URL can open and use the recorder, view the shared recording library, add or remove watchers, and delete recordings. There is no key or password anywhere in the app.

Because the service is public, do not store private or sensitive recordings on it. Visitors share the same server, recording library, and recording capacity. Use a persistent disk on your hosting provider or recordings and metadata may be lost when the instance restarts or is redeployed.

For Render, use the included `render.yaml` blueprint. It configures a Node web service and a persistent disk mounted at `/var/data`. Render will assign a public `onrender.com` URL after deployment.

## Using Burst

1. Scroll down from the hero to the sticky search dock.
2. Type a TikTok username (with or without `@`).
3. Press **Check & record**.
   - **Live:** recording starts automatically and appears under **Recording now**.
   - **Not live:** you get a calm summary and can add them to **Watching for**,
     which checks again in the background and records when they go live.
4. Finished recordings appear in **Storage**. Click a thumbnail to play,
   download with the download button, or delete with the bin button.
5. Finished recordings appear in Storage. Anyone using the public site can delete recordings from the shared library.

### Portrait framing

Every recording is saved in portrait 9:16. Use **9:16 framing** in the dock:

| Option | What it does |
| --- | --- |
| **Auto** | Centres normally, and picks the left portrait pane when a split/dual layout is detected. |
| **Centre** | Centre-crops the source to 9:16. |
| **Left portrait** | Keeps the left side — useful for dual/co-hosted layouts. |
| **Right portrait** | Keeps the right side. |

The setting applies to new recordings, including recordings started by watchers
(each watcher keeps the framing that was selected when it was added).

## How recordings are made

- Burst asks TikTok for the stream and picks the best available quality,
  preferring 1080p when TikTok offers it.
- While live, it captures to a temporary `.ts` file and encodes with H.264
  (libx264, CRF 21, `veryfast`) and AAC 160 kbps audio.
- The video filter is:

  ```
  scale=1080:1920:force_original_aspect_ratio=increase,
  crop=1080:1920:X:(ih-oh)/2,
  setsar=1
  ```

  This fills a 1080 × 1920 frame and crops the overflow horizontally, so the
  output is always true 9:16 with square pixels.
- When the stream ends, the file is remuxed to MP4 with `+faststart` for instant
  playback, and a JPG thumbnail is generated.
- If the app is closed or crashes mid-recording, the leftover `.ts` file is
  recovered and indexed on the next start.

### A note on 1080p

The saved file is always **1080 × 1920**, but that does not create detail that
TikTok did not send. Many TikTok livestreams only expose a 720p source; those are
upscaled to 1080 × 1920 so the library stays consistent. Burst still prefers a
real 1080p source whenever TikTok provides one. The library card reports the
saved resolution; the lookup result shown when a capture starts tells you which
source tier TikTok actually served.

### Dual layouts

TikTok sometimes splits a live room into two portrait feeds (co-host/link-mic).
Burst detects this on a best-effort basis and, with **Auto**, records only the
left portrait view instead of squeezing both feeds into one vertical frame. The
detection relies on the room's link-mic fields; if a split layout slips through,
choose **Left portrait** or **Right portrait** before recording.

## Storage and files

| Path | Contents |
| --- | --- |
| `recordings/` | Finished `.mp4` files and `.jpg` thumbnails |
| `data/recordings.json` | Library index (titles, users, dates, sizes, dimensions) |

Recording names look like
`2026-11-14_14-08-40_typicalgamer_rec_mwfuw0vd488cca.mp4`.

The Storage section supports filtering by username/title, sorting (newest,
oldest, largest, longest), in-browser playback, download, and code-protected
deletion. Deleting removes the MP4, thumbnail, and index entry.

## Public deletion

There is no delete code or login. Anyone with access to the public URL can permanently delete recordings from the shared library.

## Auto-record watchers

Add a username from the **not live** result to watch it. Burst re-checks watched
accounts every 60 seconds by default (minimum 15 seconds) and starts recording
automatically when one goes live. Watchers persist across restarts in
`data/watchers.json` (created when the first watcher is added) and only run while
the server is running. Remove a watcher with the × button.

## Configuration

Environment variables (all optional):

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. `start.bat` opens port 3000, so update it if you change this. |
| `HOST` | `0.0.0.0` | Network interface to bind; keep this for hosted deployments. |

| `WATCH_INTERVAL_MS` | `60000` | Watcher poll interval; clamped to at least 15000. |
| `MAX_CONCURRENT` | `3` | Maximum simultaneous recordings. |
| `PORTRAIT` | `1` | Set to `0` to store the raw source layout instead of 9:16 1080 × 1920. |
| `PORTRAIT_FRAME` | `auto` | Default framing: `auto`, `center`, `left`, or `right`. |
| `DATA_DIR` | `data/` | Where the JSON index lives. |
| `RECORDINGS_DIR` | `recordings/` | Where media is written. |
| `TIKTOK_SIGN_API_KEY` | — | Optional signing key for `tiktok-live-connector` if TikTok starts rejecting unsigned connections. |

Example (PowerShell):

```powershell
$env:PORT = "4000"
npm start
```

## Replacing the logo and favicon

The placeholder brand mark lives at **`public/logo.svg`**. Replace that file with
your own square SVG (512 × 512 recommended) and refresh the page. The matching
browser tab icon is **`public/favicon.svg`**. No code changes are needed.

## Troubleshooting

- **"Server offline" in the interface** — make sure the `npm start` / `start.bat`
  window is still open. The page reconnects automatically.
- **The recording engine is unavailable** — run `npm install` again; it downloads
  the bundled ffmpeg binary.
- **TikTok says the user is not live when they are** — private, region-locked, or
  age-restricted rooms may not expose a playable stream. Try again, and see
  `TIKTOK_SIGN_API_KEY` above if it happens across many rooms.
- **Recordings stop unexpectedly** — check free disk space (1 GB guard) and
  whether the stream ended. Partial captures are recovered on restart.
- **Port already in use** — start with a different `PORT`, e.g.
  `$env:PORT="4000"; npm start`.

## Project layout

```
streamvault/
├─ server/
│  ├─ index.js      Express app, API routes, media serving
│  ├─ recorder.js   ffmpeg capture pipeline, finalize, recovery
│  ├─ tiktok.js     live lookup, quality selection, dual-layout detection
│  ├─ watchers.js   persisted auto-record watchers
│  ├─ store.js      recording index persistence
│  ├─ config.js     paths, port, portrait settings
│  └─ util.js       logging, formatting, filesystem helpers
├─ public/
│  ├─ index.html    Burst hero, sticky search dock, storage UI
│  ├─ styles.css    black animated theme and responsive layout
│  ├─ app.js        frontend behaviour, polling, modals
│  ├─ logo.svg      replaceable brand mark
│  └─ favicon.svg   tab icon
├─ recordings/      runtime recordings (not committed)
├─ data/            runtime index/metadata (not committed)
├─ start.bat        first-run installer and launcher
└─ package.json
```

## Limitations

- This public build has no user accounts or site-wide authentication. Anyone with the URL can use the app and view the shared library. Deploy behind HTTPS and use a persistent disk. All visitors share full control of the app and its library, including permanent deletion.
- Recordings are only captured while the server is running. There is no cloud
  recording or background service.
- TikTok changes its live APIs regularly. If lookups start failing broadly,
  update the connector with `npm install tiktok-live-connector@latest`.
- A 720p source upscaled to 1080 × 1920 will not look as sharp as a native 1080p
  stream. This is a TikTok source limitation, not an encoder setting.
- Dual-layout detection is heuristic; use the framing selector if it guesses
  wrong.

## Legal

Only record streams you own or have explicit permission to record. Livestreams
and their content belong to their creators. You are responsible for complying
with TikTok's terms and with any applicable copyright, privacy, and recording
laws. Burst Recording Service is provided for personal, permitted use only.
