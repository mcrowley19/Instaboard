/** @type {import('next').NextConfig} */
const nextConfig = {
  // Overridable so a second dev server (screenshot tooling) never shares
  // .next with the main one — two writers corrupt the build cache.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["@modelcontextprotocol/sdk"],
  async headers() {
    // Let the Chrome extension call the API (no cookies involved).
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS" },
          {
            key: "Access-Control-Allow-Headers",
            value: "Content-Type, x-llm-provider, x-llm-key, x-llm-model",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
