import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";

// Read-only checks. No publishing token, upload writes, or automatic remediation.
const checks = [
  { url: "https://rune.page/", status: 200, type: "text/html", content: "Public file links for agents" },
  { url: "https://rune.page/llms.txt", status: 200, type: "text/plain", content: "If-Match" },
  { url: "https://www.rune.page/", status: 308, location: "https://rune.page/" },
  { url: "https://api.rune.page/uploads", status: 401 },
];

let failed = false;
for (const check of checks) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(check.url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
      assert.equal(response.status, check.status, `Expected ${check.status}, received ${response.status}`);
      if (check.type) assert.ok(response.headers.get("content-type")?.includes(check.type), "Wrong content type");
      if (check.location) assert.equal(response.headers.get("location"), check.location, "Wrong redirect");
      if (check.content) assert.ok((await response.text()).includes(check.content), "Expected page content missing");
      else await response.body?.cancel();
      console.log(`PASS ${check.url}`);
      break;
    } catch (error) {
      console.error(`${check.url}, attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`);
      if (attempt === 3) failed = true;
      else await setTimeout(5000);
    }
  }
}
if (failed) process.exitCode = 1;
