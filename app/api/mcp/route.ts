import { createMcpHandler } from "mcp-handler";
import { withSharedSecret } from "@/lib/auth";
import { registerGarminTools } from "@/lib/garmin/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const mcpHandler = createMcpHandler(registerGarminTools, {
  serverInfo: { name: "garmin-personal-mcp", version: "1.0.0" },
});

const handler = withSharedSecret(mcpHandler);

export { handler as GET, handler as POST, handler as DELETE };
