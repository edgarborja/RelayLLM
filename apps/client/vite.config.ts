import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Strict Content-Security-Policy for production builds: no inline or remote
 * scripts, no remote images (blocks tracking/exfiltration via markdown
 * images), and network access only to WebSocket relays.
 */
function csp(): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' wss: ws:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return {
    name: "relayllm-csp",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`);
    },
  };
}

export default defineConfig({
  // Relative base: works at any GitHub Pages path (user.github.io/repo/).
  base: "./",
  plugins: [react(), csp()],
  build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 1200 },
  server: { port: 5173 },
});
