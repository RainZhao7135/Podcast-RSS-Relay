/**
 * Podcast RSS relay for Cloudflare Workers.
 *
 * Routes (all paths require /<subscription-token> as a prefix):
 *   GET /<token>/rss/<show-slug>    Fetches and rewrites the upstream RSS.
 *   GET /<token>/audio/<show-slug>  Streams signed audio, including Range requests.
 *   GET /<token>/image/<show-slug>  Streams signed artwork images.
 *
 * Required Worker Secrets:
 *   SUBSCRIPTION_TOKEN — 16-character base64url access token.
 *   PROXY_SECRET — random signing secret of at least 32 characters.
 */

// Add one text variable per show in the Worker dashboard.
// Example: PDCT_RSS_my_show = https://feeds.example.com/show.xml
const PDCT_RSS_PREFIX = "PDCT_RSS_";

// Add one text variable per show. Underscores in the binding name become hyphens in the URL slug.
function loadShows(env) {
  const shows = Object.create(null);

  for (const [name, value] of Object.entries(env || {})) {
    if (!name.startsWith(PDCT_RSS_PREFIX)) continue;

    const slug = name.slice(PDCT_RSS_PREFIX.length).replace(/_/g, "-").toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || typeof value !== "string" || !value.trim()) {
      throw new Error(`Invalid podcast feed variable "${name}".`);
    }
    if (shows[slug]) throw new Error(`Duplicate podcast slug "${slug}".`);

    let feedUrl;
    try {
      feedUrl = new URL(value.trim());
    } catch {
      throw new Error(`Invalid feed URL for show "${slug}".`);
    }
    if (feedUrl.protocol !== "https:" || feedUrl.username || feedUrl.password) {
      throw new Error(`Show "${slug}" must use an HTTPS feed URL without credentials.`);
    }

    shows[slug] = { feedUrl: feedUrl.toString() };
  }

  return shows;
}
const MAX_FEED_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_METHODS = new Set(["GET", "HEAD"]);

export default {
  async fetch(request, env) {
    const requestUrl = new URL(request.url);
    let subscriptionToken;
    try {
      subscriptionToken = getSubscriptionToken(env);
    } catch {
      return textResponse("Service configuration error.", 500);
    }

    const routePrefix = `/${subscriptionToken}`;
    if (requestUrl.pathname !== routePrefix && !requestUrl.pathname.startsWith(`${routePrefix}/`)) {
      return textResponse("Not found.", 404);
    }
    requestUrl.pathname = requestUrl.pathname.slice(routePrefix.length) || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (!ALLOWED_METHODS.has(request.method)) {
      return textResponse("Method not allowed. Use GET or HEAD.", 405, {
        Allow: "GET, HEAD, OPTIONS",
      });
    }

    if (requestUrl.pathname === "/") {
      return textResponse("System status: OK", 200);
    }

    const rssMatch = requestUrl.pathname.match(/^\/rss\/([a-z0-9-]+)$/);
    if (rssMatch) {
      return handleRss(request, env, rssMatch[1], routePrefix);
    }

    const audioMatch = requestUrl.pathname.match(/^\/audio\/([a-z0-9-]+)$/);
    if (audioMatch) {
      return handleAudio(request, env, audioMatch[1]);
    }

    const imageMatch = requestUrl.pathname.match(/^\/image\/([a-z0-9-]+)$/);
    if (imageMatch) {
      return handleImage(request, env, imageMatch[1]);
    }
    return textResponse("Not found.", 404);
  },
};

function getSubscriptionToken(env) {
  const token = env?.SUBSCRIPTION_TOKEN;
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(token)) {
    throw new Error("SUBSCRIPTION_TOKEN must be a 16-character base64url secret.");
  }
  return token;
}
async function handleRss(request, env, slug, routePrefix) {
  let shows;
  try {
    shows = loadShows(env);
  } catch {
    return textResponse("Service configuration error.", 500);
  }
  const show = shows[slug];
  if (!show) return textResponse("Unknown podcast slug.", 404);

  let key;
  try {
    key = await getSigningKey(env);
  } catch (error) {
    return textResponse(error.message, 500);
  }

  let upstream;
  try {
    upstream = await fetch(show.feedUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        "User-Agent": "PodcastRSSRelay/1.0",
      },
    });
  } catch {
    return textResponse("Could not fetch the upstream RSS feed.", 502);
  }

  if (!upstream.ok) {
    return textResponse(`Upstream RSS returned HTTP ${upstream.status}.`, 502);
  }

  let xml;
  try {
    xml = await readTextLimited(upstream, MAX_FEED_BYTES);
  } catch (error) {
    return textResponse(`Could not read RSS: ${error.message}`, 502);
  }

  try {
    const publicOrigin = new URL(request.url).origin;
    const signatureCache = new Map();
    const xmlWithAudio = await rewriteEnclosures({
      xml,
      slug,
      publicOrigin,
      routePrefix,
      show,
      key,
      signatureCache,
    });
    const rewrittenXml = await rewriteShowArtwork({
      xml: xmlWithAudio,
      slug,
      publicOrigin,
      routePrefix,
      show,
      key,
      signatureCache,
    });

    const headers = new Headers(corsHeaders());
    headers.set("Content-Type", "application/rss+xml; charset=utf-8");
    headers.set("Cache-Control", "public, max-age=300");
    headers.set("X-Content-Type-Options", "nosniff");
    // The rewritten document may be longer than the original; don't reuse its length.
    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }
    return new Response(rewrittenXml, { status: 200, headers });
  } catch (error) {
    return textResponse(`Could not rewrite RSS: ${error.message}`, 502);
  }
}

async function rewriteEnclosures({ xml, slug, publicOrigin, routePrefix, show, key, signatureCache }) {
  const enclosureMatches = [...xml.matchAll(/<enclosure\b[^>]*>/gi)];
  if (enclosureMatches.length === 0) {
    throw new Error('No <enclosure> tags were found in this RSS feed.');
  }

  const attrRegex = /(\burl\s*=\s*)(["'])(.*?)\2/i;
  const edits = [];

  for (const match of enclosureMatches) {
    const tag = match[0];
    const attr = tag.match(attrRegex);
    if (!attr) continue;

    // RSS XML stores ampersands as &amp; inside attributes. Decode before URL parsing.
    const rawTarget = decodeXmlEntities(attr[3].trim());
    const target = validateTarget(rawTarget);
    const normalizedTarget = target.toString();
    const signature = await getCachedSignature(key, slug, normalizedTarget, signatureCache);

    // Put the target URL and signature into one base64url token.
    // This keeps the generated RSS URL to a single query parameter, avoiding
    // multiple ampersand-separated parameters and the XML &amp; copy/paste trap.
    const token = encodeAudioToken(normalizedTarget, signature);
    const proxyUrl = new URL(`${routePrefix}/audio/${slug}`, publicOrigin);
    proxyUrl.searchParams.set("t", token);

    const newTag = tag.replace(attrRegex, (_whole, prefix, quote) => {
      return `${prefix}${quote}${xmlEscapeAttribute(proxyUrl.toString())}${quote}`;
    });

    edits.push({ index: match.index, oldTag: tag, newTag });
  }

  if (edits.length === 0) {
    throw new Error('No <enclosure url="..."> attributes were found.');
  }

  // Assemble the result once. Repeated slicing of the whole XML for every
  // enclosure makes large feeds increasingly expensive (roughly O(feed × tags)).
  let cursor = 0;
  const parts = [];
  for (const edit of edits) {
    parts.push(xml.slice(cursor, edit.index), edit.newTag);
    cursor = edit.index + edit.oldTag.length;
  }
  parts.push(xml.slice(cursor));
  return parts.join("");
}

async function rewriteShowArtwork({ xml, slug, publicOrigin, routePrefix, show, key, signatureCache }) {
  const edits = [];
  // Artwork can appear at channel level or inside individual <item> entries.
  // Rewrite iTunes and Podcasting 2.0 artwork elements wherever they occur.
  const imageTagMatches = [...xml.matchAll(/<(?:itunes|podcast):image\b[^>]*>/gi)];
  const imageTagAttr = /(\b(?:href|src)\s*=\s*)(["'])(.*?)\2/i;

  for (const match of imageTagMatches) {
    const tag = match[0];
    const attr = tag.match(imageTagAttr);
    if (!attr) continue;
    const proxyUrl = await makeImageProxyUrl({
      rawTarget: decodeXmlEntities(attr[3].trim()), slug, publicOrigin, routePrefix, show, key, signatureCache,
    });
    if (!proxyUrl) continue;
    const newTag = tag.replace(imageTagAttr, (_whole, prefix, quote) =>
      `${prefix}${quote}${xmlEscapeAttribute(proxyUrl)}${quote}`,
    );
    edits.push({ index: match.index, oldText: tag, newText: newTag });
  }

  // Also rewrite the standard RSS channel image URL used by some clients.
  for (const match of xml.matchAll(/<image\b[^>]*>[\s\S]*?<\/image>/gi)) {
    const block = match[0];
    const urlTag = block.match(/(<url\b[^>]*>)([\s\S]*?)(<\/url>)/i);
    if (!urlTag) continue;
    const rawContent = urlTag[2].trim();
    const cdata = rawContent.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/i);
    const proxyUrl = await makeImageProxyUrl({
      rawTarget: decodeXmlEntities((cdata ? cdata[1] : rawContent).trim()),
      slug, publicOrigin, routePrefix, show, key, signatureCache,
    });
    if (!proxyUrl) continue;
    const imageContent = cdata
      ? `<![CDATA[${proxyUrl}]]>`
      : xmlEscapeAttribute(proxyUrl);
    const contentStart = urlTag.index + urlTag[1].length;
    const contentEnd = contentStart + urlTag[2].length;
    const newBlock = block.slice(0, contentStart) + imageContent + block.slice(contentEnd);
    edits.push({ index: match.index, oldText: block, newText: newBlock });
  }

  // Media RSS can carry episode art in media:thumbnail or image media:content.
  // Do not rewrite audio or video media:content URLs.
  const mediaTagAttr = /(\burl\s*=\s*)(["'])(.*?)\2/i;
  for (const match of xml.matchAll(/<media:(?:thumbnail|content)\b[^>]*>/gi)) {
    const tag = match[0];
    if (/^<media:content\b/i.test(tag) &&
        !/(?:\bmedium\s*=\s*["']image["']|\btype\s*=\s*["']image\/)/i.test(tag)) continue;
    const attr = tag.match(mediaTagAttr);
    if (!attr) continue;
    const proxyUrl = await makeImageProxyUrl({
      rawTarget: decodeXmlEntities(attr[3].trim()), slug, publicOrigin, routePrefix, show, key, signatureCache,
    });
    if (!proxyUrl) continue;
    const newTag = tag.replace(mediaTagAttr, (_whole, prefix, quote) =>
      `${prefix}${quote}${xmlEscapeAttribute(proxyUrl)}${quote}`,
    );
    edits.push({ index: match.index, oldText: tag, newText: newTag });
  }

  if (edits.length === 0) return xml;
  edits.sort((a, b) => a.index - b.index);
  let cursor = 0;
  const parts = [];
  for (const edit of edits) {
    parts.push(xml.slice(cursor, edit.index), edit.newText);
    cursor = edit.index + edit.oldText.length;
  }
  parts.push(xml.slice(cursor));
  return parts.join("");
}

async function makeImageProxyUrl({ rawTarget, slug, publicOrigin, routePrefix, show, key, signatureCache }) {
  try {
    const target = validateTarget(rawTarget);
    const targetUrl = target.toString();
    const signature = await getCachedSignature(key, slug, targetUrl, signatureCache);
    const token = encodeAudioToken(targetUrl, signature);
    const proxyUrl = new URL(`${routePrefix}/image/${slug}`, publicOrigin);
    proxyUrl.searchParams.set("t", token);
    return proxyUrl.toString();
  } catch {
    // Keep a bad or unsupported upstream artwork URL unchanged; audio stays usable.
    return null;
  }
}

async function getCachedSignature(key, slug, targetUrl, cache) {
  if (cache?.has(targetUrl)) return cache.get(targetUrl);
  const signature = await signTarget(key, slug, targetUrl);
  cache?.set(targetUrl, signature);
  return signature;
}

async function handleImage(request, env, slug) {
  let show;
  try {
    show = loadShows(env)[slug];
  } catch {
    return textResponse("Service configuration error.", 500);
  }
  if (!show) return textResponse("Unknown podcast slug.", 404);

  const tokens = new URL(request.url).searchParams.getAll("t");
  if (tokens.length !== 1) return textResponse("Missing or duplicated image token.", 400);

  let rawTarget;
  let suppliedSignature;
  try {
    ({ url: rawTarget, signature: suppliedSignature } = decodeAudioToken(tokens[0]));
  } catch {
    return textResponse("Invalid image token.", 400);
  }

  let key;
  let target;
  try {
    key = await getSigningKey(env);
    target = validateTarget(rawTarget);
  } catch {
    return textResponse("Invalid image target.", 403);
  }
  const normalizedTarget = target.toString();
  if (!(await verifyTarget(key, slug, normalizedTarget, suppliedSignature))) {
    return textResponse("Invalid image signature.", 403);
  }

  const outboundHeaders = new Headers({
    Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
    "Accept-Encoding": "identity",
    "User-Agent": "PodcastImageRelay/1.0",
  });
  let upstream;
  try {
    upstream = await fetchWithSafeRedirects(target, request.method, outboundHeaders);
  } catch {
    return textResponse("Image upstream request failed.", 502);
  }
  if (!upstream.ok) return textResponse("Image upstream returned an error.", 502);

  const contentType = upstream.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("image/")) {
    await upstream.body?.cancel();
    return textResponse("Image upstream did not return an image.", 502);
  }

  const headers = new Headers(corsHeaders());
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", upstream.headers.get("cache-control") || "public, max-age=86400");
  headers.set("X-Content-Type-Options", "nosniff");
  for (const name of ["content-length", "date", "etag", "expires", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers,
  });
}
async function handleAudio(request, env, slug) {
  let shows;
  try {
    shows = loadShows(env);
  } catch {
    return textResponse("Service configuration error.", 500);
  }
  const show = shows[slug];
  if (!show) return textResponse("Unknown podcast slug.", 404);

  const requestUrl = new URL(request.url);
  const tokenParams = requestUrl.searchParams.getAll("t");
  const legacyUrlParams = requestUrl.searchParams.getAll("url");
  const legacySignatureParams = requestUrl.searchParams.getAll("sig");

  let rawTarget;
  let suppliedSignature;
  try {
    if (tokenParams.length === 1 && legacyUrlParams.length === 0 && legacySignatureParams.length === 0) {
      ({ url: rawTarget, signature: suppliedSignature } = decodeAudioToken(tokenParams[0]));
    } else if (
      tokenParams.length === 0 &&
      legacyUrlParams.length === 1 &&
      legacySignatureParams.length === 1
    ) {
      // Backward compatibility for RSS links issued by older versions of this Worker.
      rawTarget = legacyUrlParams[0];
      suppliedSignature = legacySignatureParams[0];
    } else {
      return textResponse("Missing, duplicated, or invalid audio token/URL/signature.", 400);
    }
  } catch (error) {
    return textResponse(`Invalid audio token: ${error.message}`, 400);
  }

  let key;
  let target;
  try {
    key = await getSigningKey(env);
    target = validateTarget(rawTarget);
  } catch (error) {
    return textResponse(error.message, 403);
  }

  const normalizedTarget = target.toString();
  const validSignature = await verifyTarget(
    key,
    slug,
    normalizedTarget,
    suppliedSignature,
  );
  if (!validSignature) return textResponse("Invalid audio URL signature.", 403);

  const outboundHeaders = new Headers({
    Accept: request.headers.get("Accept") || "*/*",
    "Accept-Encoding": "identity",
    "User-Agent": "PodcastAudioRelay/1.0",
  });
  // Forward headers used for streaming, seeking, and cache validation.
  for (const name of ["Range", "If-Range", "If-None-Match", "If-Modified-Since"]) {
    const value = request.headers.get(name);
    if (value) outboundHeaders.set(name, value);
  }

  let upstream;
  try {
    upstream = await fetchWithSafeRedirects(
      target,
      request.method,
      outboundHeaders,
    );
  } catch (error) {
    return textResponse(`Audio upstream request failed: ${error.message}`, 502);
  }

  const headers = new Headers();
  const forwardedHeaders = [
    "accept-ranges",
    "cache-control",
    "content-disposition",
    "content-encoding",
    "content-length",
    "content-range",
    "content-type",
    "date",
    "etag",
    "expires",
    "last-modified",
  ];
  for (const name of forwardedHeaders) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  if (!headers.has("content-type") && upstream.ok) {
    headers.set("content-type", "audio/mpeg");
  }
  if (!headers.has("accept-ranges") && upstream.ok) {
    headers.set("accept-ranges", "bytes");
  }
  for (const [name, value] of Object.entries(corsHeaders())) {
    headers.set(name, value);
  }
  headers.set("X-Content-Type-Options", "nosniff");

  const body = request.method === "HEAD" ? null : upstream.body;
  return new Response(body, { status: upstream.status, headers });
}

async function fetchWithSafeRedirects(initialTarget, method, headers) {
  let current = validateTarget(initialTarget.toString());

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const response = await fetch(current.toString(), {
      method,
      headers,
      redirect: "manual",
    });

    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get("Location");
    if (!location) {
      await response.body?.cancel();
      throw new Error(`Upstream returned HTTP ${response.status} without a Location header.`);
    }
    await response.body?.cancel();

    if (redirectCount === MAX_REDIRECTS) {
      throw new Error("Too many upstream redirects.");
    }

    const nextUrl = new URL(location, current);
    current = validateTarget(nextUrl.toString());
  }

  throw new Error("Too many upstream redirects.");
}

function validateTarget(rawUrl) {
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new Error("Invalid upstream audio URL.");
  }

  if (target.protocol !== "https:") {
    throw new Error("Only HTTPS resource URLs are allowed.");
  }
  if (target.username || target.password) {
    throw new Error("Resource URLs containing credentials are not allowed.");
  }
  if (target.port && target.port !== "443") {
    throw new Error("Non-standard upstream ports are not allowed.");
  }

  target.hash = "";
  return target;
}

async function getSigningKey(env) {
  const secret = env?.PROXY_SECRET;
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error(
      "PROXY_SECRET is missing or too short. Add a Worker Secret named PROXY_SECRET with at least 32 random characters.",
    );
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signTarget(key, slug, targetUrl) {
  const payload = new TextEncoder().encode(`${slug}\n${targetUrl}`);
  const signature = await crypto.subtle.sign("HMAC", key, payload);
  return bytesToBase64Url(new Uint8Array(signature));
}

async function verifyTarget(key, slug, targetUrl, suppliedSignature) {
  try {
    const signatureBytes = base64UrlToBytes(suppliedSignature);
    const payload = new TextEncoder().encode(`${slug}\n${targetUrl}`);
    return await crypto.subtle.verify("HMAC", key, signatureBytes, payload);
  } catch {
    return false;
  }
}

function encodeAudioToken(targetUrl, signature) {
  const payload = JSON.stringify({ url: targetUrl, signature });
  return bytesToBase64Url(new TextEncoder().encode(payload));
}

function decodeAudioToken(token) {
  if (typeof token !== "string" || token.length === 0 || token.length > 8192) {
    throw new Error("Token is empty or too long.");
  }
  const bytes = base64UrlToBytes(token);
  const json = new TextDecoder("utf-8").decode(bytes);
  const payload = JSON.parse(json);
  if (
    !payload ||
    typeof payload.url !== "string" ||
    payload.url.length === 0 ||
    payload.url.length > 4096 ||
    typeof payload.signature !== "string" ||
    payload.signature.length === 0 ||
    payload.signature.length > 256
  ) {
    throw new Error("Token payload is malformed.");
  }
  return { url: payload.url, signature: payload.signature };
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid signature format.");
  let base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  base64 += "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function readTextLimited(response, maxBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const chunks = [];
  let bytesRead = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel();
        throw new Error(`RSS exceeds the ${maxBytes} byte size limit.`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

function decodeXmlEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (whole, entity) => {
    const lower = entity.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    try {
      if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
      if (lower.startsWith("#")) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    } catch {
      return whole;
    }
    return whole;
  });
}

function xmlEscapeAttribute(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, If-Range, If-None-Match, If-Modified-Since",
    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Range, Content-Length, ETag, Last-Modified",
  };
}

function textResponse(message, status = 200, extraHeaders = {}) {
  const headers = new Headers({
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...corsHeaders(),
    ...extraHeaders,
  });
  return new Response(message, { status, headers });
}

