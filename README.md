# Getclip

YouTube and Instagram downloader. Static front end in `public/`, Node backend in `server/` that runs yt-dlp.

## Run locally

Requirements: Node 18+, [yt-dlp](https://github.com/yt-dlp/yt-dlp), and ffmpeg (needed for 1080p and above, and for MP3/M4A).

```
npm install
cp .env.example .env     # optional, then export the variables you need
npm start
```

Open http://localhost:3000.

The front end cannot download from YouTube or Instagram on its own. Browsers block those requests, so the site must run with the backend. Plain static hosting (GitHub Pages and similar) will load the pages but every download will fail.

## How the backend works

| Endpoint | Purpose |
| --- | --- |
| `POST /api/info` | Validates the link, runs `yt-dlp -J`, returns title, thumbnail, duration and the formats that exist |
| `POST /api/prepare` | Runs yt-dlp for the chosen format into a temp folder, returns a one-time download URL |
| `GET /api/file/:token` | Streams the prepared file. Files are deleted after at most 10 minutes |
| `GET /api/thumb?u=` | Proxies thumbnails from an allowlist of image hosts (Instagram blocks hotlinking) |

Safety built in: strict hostname allowlist for input links, arguments passed as an array (no shell), per-IP rate limits, a cap on parallel jobs, and automatic cleanup of temp files.

## Deploy

Use the included `Dockerfile` on any host that runs containers (Fly.io, Railway, Render, a VPS). It installs ffmpeg and yt-dlp.

- Put a reverse proxy with HTTPS in front and set `TRUST_PROXY=1`.
- Raise proxy timeouts to at least 15 minutes. 4K files can take a while to prepare. Example for Caddy:

```
yourdomain.com {
  reverse_proxy localhost:3000 {
    transport http {
      response_header_timeout 20m
    }
  }
}
```

- Keep yt-dlp current. YouTube and Instagram change often, and an old yt-dlp is the most common cause of failures. Rebuild the image or run `yt-dlp -U` regularly.

## Custom domain

1. Point your domain's DNS (A or CNAME record) at the host.
2. Run `node scripts/set-domain.js yourdomain.com`. It updates canonical links, Open Graph URLs, `robots.txt` and `sitemap.xml`.
3. Submit `https://yourdomain.com/sitemap.xml` in Google Search Console.

## Before launch

- Add a contact email to the Terms and Privacy pages. Both pages currently have no contact address.
- Have a lawyer review the Terms and Privacy pages for your country.
- Brand name is "Getclip". Search and replace it across `public/` if you want another name.
- Instagram stories and some posts need a logged-in session. Set `YTDLP_COOKIES` to a cookies file from a throwaway account.

## Project layout

```
public/            static site (pages, css, js, favicon, robots, sitemap)
server/server.js   API and static file server
scripts/           set-domain.js
Dockerfile
.env.example