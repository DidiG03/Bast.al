/**
 * The device and browser behind a User-Agent string, for sign-in history:
 * "iPhone · Safari", "Mac · Chrome", "Android phone · Samsung Internet".
 * Returns null for anything that isn't a browser (our own web server calling
 * the API says "node"), so it never overwrites what a real visit recorded.
 */
export function parseUserAgent(userAgent: string | null | undefined): { device: string; browser: string } | null {
  if (!userAgent || !/Mozilla\/|Opera\//.test(userAgent)) return null;
  const ua = userAgent;

  let device = "Desktop";
  if (/iPhone/.test(ua)) device = "iPhone";
  else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile\//.test(ua))) device = "iPad";
  else if (/Android/.test(ua)) device = /Mobile/.test(ua) ? "Android phone" : "Android tablet";
  else if (/CrOS/.test(ua)) device = "Chromebook";
  else if (/Macintosh|Mac OS X/.test(ua)) device = "Mac";
  else if (/Windows/.test(ua)) device = "Windows PC";
  else if (/Linux/.test(ua)) device = "Linux PC";
  else if (/Mobile/.test(ua)) device = "Mobile device";

  // Order matters: Edge, Opera and Samsung Internet also say "Chrome", and Chrome says "Safari".
  const browsers: Array<[RegExp, string]> = [
    [/Edg(e|A|iOS)?\//, "Edge"],
    [/OPR\/|Opera/, "Opera"],
    [/SamsungBrowser\//, "Samsung Internet"],
    [/YaBrowser\//, "Yandex Browser"],
    [/FxiOS\/|Firefox\//, "Firefox"],
    [/CriOS\/|Chrome\//, "Chrome"],
    [/Version\/[\d.]+.*Safari\//, "Safari"],
  ];
  const browser = browsers.find(([pattern]) => pattern.test(ua))?.[1] ?? (/AppleWebKit/.test(ua) && /Mobile\//.test(ua) ? "Safari" : "Unknown browser");
  return { device, browser };
}
