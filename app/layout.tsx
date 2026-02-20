import type { Metadata } from "next";
import { Fraunces, Manrope } from "next/font/google";
import "./globals.css";

const manrope = Manrope({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const fraunces = Fraunces({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["500", "600", "700", "800", "900"],
});

export const metadata: Metadata = {
  title: "Frontend LLM Evaluator",
  description:
    "Evaluate how different LLMs and agents redesign the same landing page prompt.",
  icons: {
    icon: [
      { url: "/hf-favicons/favicon.ico" },
      { url: "/hf-favicons/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/hf-favicons/favicon-32x32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: [{ url: "/hf-favicons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    shortcut: ["/hf-favicons/favicon.ico"],
  },
  manifest: "/hf-favicons/site.webmanifest",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{if(localStorage.getItem('theme')==='dark'){document.documentElement.classList.add('dark')}}catch(e){}})()`,
          }}
        />
      </head>
      <body className={`${manrope.variable} ${fraunces.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
