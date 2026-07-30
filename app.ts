import { app } from "./src/index.js";

// Vercel's Hono runtime discovers a default-exported app at the repository
// root. Local Bun development continues to use src/index.ts and port 3002.
export default app;
