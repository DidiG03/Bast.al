import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Providers } from "../components/providers";
import type { Theme } from "../components/theme-provider";
import "./globals.css";

export const metadata: Metadata = { title: "Bast.al" };
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
