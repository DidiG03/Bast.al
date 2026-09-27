import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { Providers } from "../components/providers";
import type { Theme } from "../components/theme-provider";
import "./globals.css";

export const metadata: Metadata = { title: "Bast.al" };
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#071d14" },
    { media: "(prefers-color-scheme: light)", color: "#f4f7f5" },
  ],
};
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const cookieTheme = cookies().get("bastal-theme")?.value;
  const initialTheme: Theme = cookieTheme === "light" ? "light" : "dark";

  return (
    <html lang="en" data-theme={initialTheme}>
      <body>
        <Providers initialTheme={initialTheme}>{children}</Providers>
      </body>
    </html>
  );
}
