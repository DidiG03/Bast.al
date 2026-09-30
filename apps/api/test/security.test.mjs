import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { clientContext, normalizeIp } from "../dist/security/client-context.js";
import { clientIp } from "../dist/security/client-ip.js";
import { parseUserAgent } from "../dist/security/user-agent.js";

const SECRET = "ab".repeat(32);

/** Signs visitor details the way the web app's /api/backend proxy does. */
function signed(fields, secret = SECRET) {
  const payload = Buffer.from(JSON.stringify({ ts: Date.now(), ...fields })).toString("base64url");
  const signature = createHmac("sha256", Buffer.from(secret, "hex")).update(payload).digest("hex");
  return { "x-bastal-client": payload, "x-bastal-client-sig": signature };
}

const request = (headers, ip = "::ffff:100.64.0.19") => ({ headers, ip, socket: { remoteAddress: ip } });

test("the visitor's address and place are believed only when the web app signed them", () => {
  process.env.REQUEST_INTEGRITY_SECRET = SECRET;
  try {
    const good = request(signed({ ip: "84.20.70.1", ua: "Mozilla/5.0 (iPhone)", country: "AL", city: "Tirana" }));
    assert.deepEqual(clientContext(good), { ip: "84.20.70.1", userAgent: "Mozilla/5.0 (iPhone)", country: "AL", region: null, city: "Tirana" });
    assert.equal(clientIp(good), "84.20.70.1");

    const tampered = signed({ ip: "84.20.70.1" });
    tampered["x-bastal-client"] = Buffer.from(JSON.stringify({ ip: "1.1.1.1", ts: Date.now() })).toString("base64url");
    assert.equal(clientContext(request(tampered)), null, "a changed payload fails the signature");
    assert.equal(clientIp(request(tampered)), "100.64.0.19", "then the API's own view is used, without ::ffff:");

    assert.equal(clientContext(request(signed({ ip: "84.20.70.1", ts: Date.now() - 10 * 60_000 }))), null, "a stale header is refused");
    assert.equal(clientContext(request(signed({ ip: "84.20.70.1" }, "cd".repeat(32)))), null, "another secret is refused");
    assert.equal(clientContext(request({ "x-bastal-client": "e30", "x-bastal-client-sig": "zz" })), null);
  } finally {
    delete process.env.REQUEST_INTEGRITY_SECRET;
  }
  assert.equal(clientContext(request(signed({ ip: "84.20.70.1" }))), null, "without the secret nothing is believed");
});

test("IPv4 addresses written the IPv6 way are shown plainly", () => {
  assert.equal(normalizeIp("::ffff:100.64.0.19"), "100.64.0.19");
  assert.equal(normalizeIp("2a02:2f0c::1"), "2a02:2f0c::1");
});

test("sign-in history names the device and browser", () => {
  const cases = [
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36", "Mac", "Chrome"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15", "Mac", "Safari"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1", "iPhone", "Safari"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1", "iPhone", "Chrome"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0", "Windows PC", "Edge"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0", "Windows PC", "Firefox"],
    ["Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36", "Android phone", "Samsung Internet"],
    ["Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36", "Android tablet", "Chrome"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/122.0.0.0", "Mac", "Opera"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1", "iPad", "Safari"],
  ];
  for (const [ua, device, browser] of cases) assert.deepEqual(parseUserAgent(ua), { device, browser }, ua);
  assert.equal(parseUserAgent("node"), null, "our own web server's calls aren't a browser");
  assert.equal(parseUserAgent("undici"), null);
  assert.equal(parseUserAgent(null), null);
});
