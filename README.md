# Podcast-RSS-Relay

A Cloudflare Workers podcast RSS relay for streaming podcasts when their hosts are blocked.

Podcast-RSS-Relay fetches configured feeds, rewrites episode audio and supported artwork links, and streams those resources through a token-protected Worker. Audio range requests are forwarded to support seeking and playback recovery.

## Highlights

- Add each podcast by creating one Cloudflare Text variable.
- Proxy RSS feeds, episode audio, and supported artwork.
- Sign audio and artwork URLs with HMAC-SHA256.
- Forward audio range and cache-validation headers.
- Protect every route with one shared subscription token.
- Validate upstream media URLs and HTTPS redirects.

## Configure the Worker

Prepare the following variables before deployment. Add them in the Cloudflare dashboard under **Workers & Pages → your Worker → Settings → Variables and Secrets**.

| Name | Type | How many | Value |
| --- | --- | --- | --- |
| `PDCT_RSS_<show_name>` | Text | One per show | The show's HTTPS RSS feed URL. |
| `SUBSCRIPTION_TOKEN` | Secret | One | Exactly 16 URL-safe random characters. |
| `PROXY_SECRET` | Secret | One | A separate random value of at least 32 characters. |

A setup with **N shows needs N + 2 bindings** in total: N feed variables and the two required Secrets.

The two secrets are required by the code. Generate them yourself before adding them to Cloudflare; do not copy example values from a public repository. Never commit secrets to GitHub.

### Generate the secrets on Windows

Run these commands in **PowerShell** (not Command Prompt). Each command prints a value to enter as the matching Cloudflare Secret.

For `SUBSCRIPTION_TOKEN` (16 URL-safe characters):

```powershell
$b = New-Object byte[] 12; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b).TrimEnd('=').Replace('+','-').Replace('/','_')
```

For `PROXY_SECRET` (32 random bytes, encoded as text):

```powershell
$b = New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b).TrimEnd('=')
```

Keep the two values private and separate. `SUBSCRIPTION_TOKEN` gates the routes; `PROXY_SECRET` signs and verifies the generated audio and image links.

### Add podcast feeds

Create one **Text** variable per show. The Worker takes the part after `PDCT_RSS_`, converts it to lowercase, and changes underscores to hyphens to form the show slug.

| Variable name | Example value | Resulting slug |
| --- | --- | --- |
| `PDCT_RSS_my_show` | `https://feeds.example.com/my-show.xml` | `my-show` |
| `PDCT_RSS_myshow` | `https://feeds.example.com/myshow.xml` | `myshow` |
| `PDCT_RSS_news_24` | `https://feeds.example.com/news-24.xml` | `news-24` |

So, `PDCT_RSS_my_show` creates the RSS route `/rss/my-show`, while `PDCT_RSS_myshow` creates `/rss/myshow`. Use only HTTPS feed URLs without embedded credentials.

## Deploy

1. Prepare the feed URLs and generate both secrets as described above.
2. Create a Worker in the Cloudflare dashboard and open its code editor.
3. Paste the Worker source code.
4. In **Settings → Variables and Secrets**, add one `PDCT_RSS_<show_name>` **Text** variable per show, plus the `SUBSCRIPTION_TOKEN` and `PROXY_SECRET` **Secrets**.
5. Save and deploy the Worker after all required bindings are configured.

Cloudflare documentation: [Environment variables](https://developers.cloudflare.com/workers/configuration/environment-variables/) · [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

## Subscribe

Use this URL in your podcast app:

```text
https://<worker-host>/<SUBSCRIPTION_TOKEN>/rss/<show-slug>
```

For example, if the variable is `PDCT_RSS_my_show`:

```text
https://<worker-host>/<SUBSCRIPTION_TOKEN>/rss/my-show
```

The Worker rewrites enclosure and supported artwork URLs. Podcast apps then request episode audio and images through the corresponding token-protected proxy routes.

## Routes

All routes require the subscription-token prefix.

| Route | Purpose |
| --- | --- |
| `/<token>/rss/<show-slug>` | Fetches and rewrites a podcast feed. |
| `/<token>/audio/<show-slug>?t=...` | Streams signed audio and supports `GET`, `HEAD`, and range requests. |
| `/<token>/image/<show-slug>?t=...` | Streams a signed artwork image. |
| `/<token>/` | Token-protected health check. |

Requests without the correct token prefix receive `404 Not found`. The Worker accepts `GET`, `HEAD`, and `OPTIONS` requests.

## Supported artwork

The Worker rewrites iTunes and Podcasting 2.0 image elements, standard RSS channel image URLs, and Media RSS thumbnail or image-content URLs. Images embedded in episode descriptions or HTML content, such as `<img src="...">`, are not rewritten.

## Security and privacy

`SUBSCRIPTION_TOKEN` is a shared access token, not individual user authentication. Anyone with a subscription URL or a copy of the rewritten feed can access its proxied resources. Rotating `SUBSCRIPTION_TOKEN` invalidates old subscription URLs. Rotating `PROXY_SECRET` invalidates previously generated audio and image signatures.

Configure feed URLs and secrets in your Cloudflare Worker settings. Do not commit secret values to this repository.

Podcast audio and artwork belong to their respective owners. This project only relays content from the feeds you configure. Make sure you have permission to access and relay that content.

## Acknowledgements

Built by the project author in collaboration with OpenAI Codex, using GPT-6 Luna.

## License

This project is licensed under the [MIT License](LICENSE).
