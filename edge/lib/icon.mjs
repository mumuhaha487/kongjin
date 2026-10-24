import { publicFetch } from './public-fetch.mjs';
async function bodyBytes(response,max){let n=0;const chunks=[];for await(const b of response.body){n+=b.length;if(n>max)throw new Error('Icon too large');chunks.push(b);}return Buffer.concat(chunks,n);}
export function publicHost(host) {
  if (
    typeof host !== "string" ||
    host.length > 253 ||
    host !== host.trim() ||
    !host.includes(".") ||
    host.endsWith(".") ||
    host.includes(":") ||
    /^\d+(?:\.\d+)*$/.test(host)
  )
    return false;
  const h = host.toLowerCase();
  if (
    /(^|\.)(localhost|local|internal|lan|localdomain|home|invalid|test)$/.test(
      h,
    )
  )
    return false;
  const labels = h.split(".");
  if (
    !labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) ||
    /^\d+$/.test(labels.at(-1))
  )
    return false;
  try {
    return new URL("https://" + h).hostname === h;
  } catch {
    return false;
  }
}
export function imageType(b) {
  if (
    b[0] === 137 &&
    b[1] === 80 &&
    b[2] === 78 &&
    b[3] === 71 &&
    b[4] === 13 &&
    b[5] === 10 &&
    b[6] === 26 &&
    b[7] === 10
  )
    return "image/png";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  const s = new TextDecoder().decode(b.slice(0, 16));
  if (s.startsWith("GIF87a") || s.startsWith("GIF89a")) return "image/gif";
  if (s.startsWith("RIFF") && s.slice(8, 12) === "WEBP") return "image/webp";
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0)
    return "image/x-icon";
  if (new TextDecoder().decode(b.slice(0, 256)).trimStart().startsWith("<svg"))
    return "image/svg+xml";
  return null;
}
export async function safeFetch(url, max, fetcher = fetch) {
  let current = new URL(url);
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (
      !["https:", "http:"].includes(current.protocol) ||
      current.username ||
      current.password ||
      (current.port && !["80", "443"].includes(current.port)) ||
      !publicHost(current.hostname)
    )
      throw new Error("Unsafe icon destination");
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetcher(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "Kongjing-Icon/2.0",
          Accept: "text/html,image/*",
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        if (redirects === 3 || !response.headers.get("Location"))
          throw new Error("Redirect limit");
        current = new URL(response.headers.get("Location"), current);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Icon origin unavailable");
      }
      return { data: await bodyBytes(response, max), url: current.href };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Redirect limit");
}
export async function fetchIcon(host, fetcher = fetch) {
  let page;
  for (const scheme of ["https", "http"])
    try {
      page = await safeFetch(scheme + "://" + host + "/", 262144, fetcher);
      break;
    } catch {}
  const candidates = [];
  if (page) {
    const html = new TextDecoder().decode(page.data);
    for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
      const attr = (name) =>
        new RegExp(
          "\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))",
          "i",
        )
          .exec(tag)
          ?.slice(1)
          .find((x) => x !== undefined);
      const rel = attr("rel") ?? "",
        href = attr("href");
      if (
        /(?:^|\s)(?:icon|apple-touch-icon|shortcut)(?:\s|$)/i.test(rel) &&
        href
      ) {
        const size = parseInt(attr("sizes") ?? "0");
        candidates.push({
          href: new URL(href, page.url).href,
          priority: /apple-touch-icon/i.test(rel)
            ? 0
            : size >= 64
              ? 1
              : /svg/i.test(href)
                ? 2
                : 3,
        });
      }
    }
  }
  candidates.sort((a, b) => a.priority - b.priority);
  candidates.push({ href: "https://" + host + "/favicon.ico", priority: 4 });
  for (const c of candidates.slice(0, 12)) {
    try {
      const { data } = await safeFetch(c.href, 131072, fetcher);
      const type = imageType(data);
      if (type) return { data, type };
    } catch {}
  }
  return null;
}

export async function fetchPublicIcon(host,fetcher=publicFetch){if(!publicHost(host))return Response.json({error:{code:'BAD_REQUEST',message:'Public hostname required'}},{status:400});const result=await fetchIcon(host,fetcher);return result?new Response(result.data,{headers:{'Content-Type':result.type,'Cache-Control':'public, max-age=604800',...(result.type==='image/svg+xml'?{'Content-Security-Policy':'sandbox'}:{})}}):Response.json({error:{code:'NOT_FOUND',message:'Icon not found'}},{status:404});}
