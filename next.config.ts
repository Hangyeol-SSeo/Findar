import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/applications/*/fill/freeform": [
      "./scripts/generate-application-docx.py",
      "./assets/templates/freeform-application.docx",
    ],
  },
};

export default nextConfig;
