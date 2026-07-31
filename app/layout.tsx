import type { Metadata } from "next";
import { Archivo } from "next/font/google";
import "./globals.css";

// Display face for the front page only; the app UI stays on --sans.
const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--f-display",
  display: "swap",
});

export const metadata: Metadata = {
  title: "instaboard — DataHub onboarding copilot",
  description: "Turn your DataHub catalog into a personal tutor for new data hires",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={archivo.variable}>
      <body>{children}</body>
    </html>
  );
}
