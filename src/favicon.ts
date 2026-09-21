// Approved variant B from assets/brand/favicon-rounded.svg, rasterized at 64px.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAADuUlEQVR4AeSbTW7aQBiGja+QoBwhdJELwKpSDoC6TNflBrBopS4qtQu4AV03y4p9InXFCbJocoNGwBVwv8d4iAEHe2zPTwzyi4eZ8fh7n/nxgEQYHHmdnZ112u325/Pz8zvRP1H0RkSsd8SOhyMWg0wAYvJS9KvVav2Noui7NHAtuhC9lYNYr4kdD3gRXWYFfwBAKn6Sio+iG1FTDrw8Jt52PO0AYMhI6VTU1GOaeNz62wKADkNmW9LQBB7xquzFACSD+dHknld+1XmaeN4ugl9VyQmdY89h8phgkTgh77HVG7yH8voQfyzxNpvNgsVioaXRaFTiTmYuwXsoi8J7M81ntzocDmNgPoDAO4vgVeDg5QmIKwCwa3KAYHNLxyAuALCJxPG7KxDeAFD8AcH6gFSeybN3ADALBASEXq9HljF5CUC5BQKPWkCovKrn/euNA5jP5/v31P4MCPYbJkAYBzCZTAKk7TrjAhMgjAPAx3g8DuRrqJcgrAAAAjIBouq0sAoACKhuELRZVk4AqGB9AOEUgA8gvACwD6KOR6dqM+/sFQB2fWx8OOcFXle5cQBFexPjyKZ5IBoHwE2OCcPs8jgfq2eqzBkADNPjqIq5oiPstXs4AcDmBeNAeC2wvHyMs7vknFf3WLlVABjGOHv6Y0HllfX7/aAvyqtXpNwaAJ96PQ3GOIC6ep1vlGV6PW02K20cAEMeCFk3L5LHHMc42+Yi9XXrGAegG1C6vup1IKTz60x7CQDDJns9DdA7ADZ63VsAtnrdWwBV9wdpY0XTXk0BnhZVnxpFjat6XgEgKNsQvAMABMRIYPdI2qSsAOCxVsYEa4JpCFYA8GhDPkKwAgDjbGWrQGBK0E7dsgaAwIHAs560rlgcTfxyZBUAplkPqvyQwUioc12wDgAIiJFQZUrUBcEZACAwJeqGQLs6cgqAQF1DcA5AQWBKkNZVt9vVvWSnvhcAiEgtjmWnBG2UkTcAVPBVpoRqQ+dsBQC9qxOUTQgAeNYJzlZdIJRdFzRifAbAg8YFVqsycqpsmgoE+xC2Wq0/BSo6rcJIMLE44j1cr9e/y7ojMHooT2XbT1/HlMi6DzGk6+mk8R6uViv+Inerc2FD6t7inTUAP994OzHFnmMAy+XyScwPRKdyDBLP23+NBZLxUxaFL00ngEe8Kp/xCFAf5AeHH5Ju8kgYJB7F5ubYAUBWQqcj6SYtjHjpJN7E2stxAIAiqfgk+hhF0TuGjOTdi7zcMUpcWQex3hM7HvAiYp07qPsfAAD//1ObHBoAAAAGSURBVAMA7qHRqBhWtbYAAAAASUVORK5CYII=";
export const FAVICON_LINK = `<link rel="icon" type="image/png" href="data:image/png;base64,${PNG}">`;

export function faviconResponse(request: Request): Response {
  const png = Uint8Array.from(atob(PNG), character => character.charCodeAt(0));
  // An ICO container with a PNG payload also supports browsers' implicit /favicon.ico lookup.
  const ico = new Uint8Array(22 + png.length);
  const header = new DataView(ico.buffer);
  header.setUint16(2, 1, true);
  header.setUint16(4, 1, true);
  ico[6] = ico[7] = 64;
  header.setUint16(10, 1, true);
  header.setUint16(12, 32, true);
  header.setUint32(14, png.length, true);
  header.setUint32(18, 22, true);
  ico.set(png, 22);
  return new Response(request.method === "HEAD" ? null : ico, {
    headers: {
      "content-type": "image/x-icon",
      "content-length": String(ico.length),
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}

/** Add the icon and a fallback tab title without modifying stored HTML or its sandbox. */
export function addPageMetadata(response: Response, filename: string): Response {
  let inserted = false;
  let hasTitle = false;
  let titleHasText = false;
  const fallbackTitle = `<title>${filename.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</title>`;
  return new HTMLRewriter()
    .on("title", {
      element(element) {
        hasTitle = true;
        titleHasText = false;
        element.onEndTag(end => {
          if (!titleHasText) end.before(filename);
        });
      },
      text(text) {
        if (text.text.trim()) titleHasText = true;
      },
    })
    .on("link", {
      element(element) {
        const rel = (element.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
        if (rel.some(value => ["icon", "apple-touch-icon", "mask-icon"].includes(value))) element.remove();
      },
    })
    .on("head", {
      element(element) {
        if (!inserted) element.append(FAVICON_LINK, { html: true });
        inserted = true;
        element.onEndTag(end => {
          if (!hasTitle) {
            end.before(fallbackTitle, { html: true });
            hasTitle = true;
          }
        });
      },
    })
    .on("body", {
      element(element) {
        if (!inserted) element.prepend(FAVICON_LINK, { html: true });
        inserted = true;
      },
    })
    .onDocument({
      end(end) {
        if (!inserted) end.append(FAVICON_LINK, { html: true });
        if (!hasTitle) end.append(fallbackTitle, { html: true });
      },
    })
    .transform(response);
}
