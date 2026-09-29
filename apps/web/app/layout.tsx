import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { Providers } from "../components/providers";
import type { Theme } from "../components/theme-provider";
import { getLang } from "../lib/i18n/server";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans/700.css";
import "./globals.css";
import "./admin.css";

export const metadata: Metadata = { title: "Bast.al" };
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0b0b0c" },
    { media: "(prefers-color-scheme: light)", color: "#f3f3f1" },
  ],
};
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const cookieTheme = cookies().get("bastal-theme")?.value;
  // No saved choice means the page follows the device's light or dark setting.
  const initialTheme: Theme | null = cookieTheme === "light" || cookieTheme === "dark" ? cookieTheme : null;
  const lang = getLang();

  return (
    <html lang={lang} data-theme={initialTheme ?? undefined}>
      <body>
        <Providers initialTheme={initialTheme} lang={lang}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
