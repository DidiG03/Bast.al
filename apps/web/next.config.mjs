/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // Runs instrumentation.ts at server start (error reporting). Built in from Next 15.
  experimental: { instrumentationHook: true },
  // pixi-reels (the Casino's reels) can play Spine animations through an optional
  // add-on that needs a paid Spine licence. We don't install or use it, and
  // pixi-reels copes with it missing; this stops the build looking for it.
  webpack(config) {
    config.resolve.alias = { ...config.resolve.alias, "@esotericsoftware/spine-pixi-v8": false };
    return config;
  },
  // Short and old addresses still in links, bookmarks and old notifications.
  async redirects() {
    return [
      { source: "/casino", destination: "/dashboard/casino", permanent: false },
      { source: "/casino/:path*", destination: "/dashboard/casino/:path*", permanent: false },
      { source: "/dashboard/prices", destination: "/dashboard/odds", permanent: false },
      { source: "/dashboard/prices/:path*", destination: "/dashboard/odds", permanent: false },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://clerk.shtatat.al https://*.clerk.accounts.dev https://*.clerk.com",
              "worker-src 'self' blob:",
              "child-src 'self' blob:",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https:",
              "font-src 'self' data:",
              "connect-src 'self' http://localhost:4000 https://clerk.shtatat.al https://*.protect.clerk.com:* https://clerk-telemetry.com https://*.clerk.accounts.dev https://*.clerk.com https://*.ingest.sentry.io https://*.ingest.us.sentry.io https://*.ingest.de.sentry.io",
              "frame-src 'self' https://clerk.shtatat.al https://*.clerk.accounts.dev https://*.clerk.com",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};
export default nextConfig;
