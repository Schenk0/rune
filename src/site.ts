import home from "./site/home.html";
import instructions from "./site/llms.txt";
import logo from "../assets/brand/rune-s2-trimmed.svg";
import { FAVICON_LINK, faviconResponse } from "./favicon";

const html = home.replace("<!--favicon-->", FAVICON_LINK).replace("<!--logo-->", logo);

/** Static first-party pages never read uploads or consume their daily budget. */
export function serveSite(request: Request, publicOrigin: string): Response {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  if (url.hostname.startsWith("www.")) {
    const canonical = new URL(publicOrigin);
    canonical.pathname = url.pathname;
    canonical.search = url.search;
    return Response.redirect(canonical.href, 308);
  }
  if (url.pathname === "/favicon.ico") return faviconResponse(request);
  const content = url.pathname === "/" ? html : url.pathname === "/llms.txt" ? instructions : undefined;
  if (content === undefined) return new Response(request.method === "HEAD" ? null : "Not found", { status: 404 });
  return new Response(request.method === "HEAD" ? null : content, {
    headers: {
      "content-type": url.pathname === "/" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
      "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "permissions-policy": "camera=(), geolocation=(), microphone=()",
    },
  });
}
