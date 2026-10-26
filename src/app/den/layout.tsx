import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Inter } from "next/font/google";

// Denní list žije mimo /w/[wsId] — bez menu, timeru a nástěnek. Vlastní
// písma i barvy (tokeny day-* v globals.css), ať je na první pohled jinde.

const display = Bricolage_Grotesque({
  variable: "--font-day-display",
  subsets: ["latin", "latin-ext"],
});

const body = Inter({
  variable: "--font-day-body",
  subsets: ["latin", "latin-ext"],
});

export const metadata: Metadata = {
  title: "Denní list — Kronos.",
};

export const viewport: Viewport = {
  themeColor: "#fafaf8",
};

export default function DenLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={`${display.variable} ${body.variable} flex-1 bg-day-bg font-day-body text-day-ink`}
    >
      {children}
    </div>
  );
}
