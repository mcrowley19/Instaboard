import type { Metadata } from "next";
import { Fraunces, Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";

/**
 * Front-page type stack. The concept is "The Handover File" — a personnel
 * dossier: a characterful serif for the headlines, a quiet grotesque for
 * reading, and mono for everything that behaves like a stamp or a field label.
 * The app UI itself stays on --sans; these only matter on the landing page.
 */
const fraunces = Fraunces({
  subsets: ["latin"],
  axes: ["SOFT", "WONK", "opsz"],
  weight: "variable",
  variable: "--f-display",
  display: "swap",
});

const hanken = Hanken_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--f-body",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--f-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "instaboard — capture what leaves when someone leaves",
  description:
    "A DataHub-native agent that records how work actually gets done, writes it back to the catalog, and tells you when it has gone stale.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${hanken.variable} ${jetbrains.variable}`}>
      <body>{children}</body>
    </html>
  );
}
