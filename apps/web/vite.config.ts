import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	plugins: [react()],
	server: {
		port: 5173,
		strictPort: false,
		proxy: {
			"/v1": "http://127.0.0.1:4317",
			"/healthz": "http://127.0.0.1:4317",
		},
	},
});
