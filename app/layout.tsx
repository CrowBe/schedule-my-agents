import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Schedule my agents",
  description: "Self-hosted calendar bridge for MCP Events subscribers.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
