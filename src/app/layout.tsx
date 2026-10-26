import type { Metadata, Viewport } from "next";
import { Familjen_Grotesk, Geist, Geist_Mono } from "next/font/google";
import Toaster from "@/components/Toaster";
import ConfirmDialog from "@/components/ConfirmDialog";
import SessionWatcher from "@/components/SessionWatcher";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin", "latin-ext"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin", "latin-ext"],
});

const display = Familjen_Grotesk({
  variable: "--font-display",
  subsets: ["latin", "latin-ext"],
});

export const metadata: Metadata = {
  title: "Kronos.", // s tečkou jako logo v aplikaci
  description: "Nástěnky a měření času pro firmu",
};

// Mobil: šířka podle zařízení, kryjeme výřez (notch) přes viewport-fit.
// Pinch-zoom vědomě NEomezujeme — kvůli přístupnosti.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#ffffff",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="cs"
      className={`${geistSans.variable} ${geistMono.variable} ${display.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <Toaster />
        <ConfirmDialog />
        <SessionWatcher />
      </body>
    </html>
  );
}
