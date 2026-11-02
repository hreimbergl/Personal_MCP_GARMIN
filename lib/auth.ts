import { timingSafeEqual } from "node:crypto";

// El endpoint expone datos personales de salud: exige un secreto compartido
// (MCP_AUTH_TOKEN) por header `Authorization: Bearer <token>` o por `?token=`
// en la URL, para clientes que no permiten headers propios.

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function unauthorized(message: string, status = 401): Response {
  return Response.json(
    { error: message },
    { status, headers: status === 401 ? { "WWW-Authenticate": 'Bearer realm="garmin-mcp"' } : {} },
  );
}

export function withSharedSecret(
  handler: (req: Request) => Response | Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const expected = process.env.MCP_AUTH_TOKEN?.trim();
    if (!expected) {
      return unauthorized(
        "Servidor sin configurar: define la variable de entorno MCP_AUTH_TOKEN.",
        500,
      );
    }
    const header = req.headers.get("authorization") ?? "";
    const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
    const query = new URL(req.url).searchParams.get("token") ?? undefined;
    const provided = bearer ?? query;
    if (!provided || !safeEqual(provided, expected)) {
      return unauthorized("Token MCP ausente o inválido.");
    }
    return handler(req);
  };
}
