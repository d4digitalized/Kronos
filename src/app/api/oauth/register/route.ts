import { registerOAuthClient, jsonCors, corsPreflight } from "@/lib/mcp/oauth";

// RFC 7591 Dynamic Client Registration. Claude si tudy zaregistruje klienta
// a dostane client_id (veřejný klient s PKCE, bez secretu).

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return corsPreflight();
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonCors(
      { error: "invalid_client_metadata", error_description: "Tělo musí být JSON." },
      400
    );
  }

  const b = body as Record<string, unknown>;
  const redirectUris = Array.isArray(b.redirect_uris)
    ? (b.redirect_uris.filter((u) => typeof u === "string") as string[])
    : [];
  if (redirectUris.length === 0) {
    return jsonCors(
      { error: "invalid_redirect_uri", error_description: "redirect_uris je povinné." },
      400
    );
  }
  for (const u of redirectUris) {
    try {
      const url = new URL(u);
      // http jen pro lokální klienty (Claude Code / desktop na loopbacku) —
      // jinak by kód mohl odejít nešifrovaně na cizí server
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (url.hash) throw new Error();
      if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
        throw new Error();
    } catch {
      return jsonCors(
        { error: "invalid_redirect_uri", error_description: `Neplatné redirect_uri: ${u}` },
        400
      );
    }
  }

  const name = typeof b.client_name === "string" ? b.client_name : "MCP client";
  let clientId: string;
  try {
    clientId = await registerOAuthClient(name, redirectUris);
  } catch {
    return jsonCors(
      {
        error: "server_error",
        error_description: "Registrace klienta selhala (je aplikovaná migrace 0016?).",
      },
      500
    );
  }

  return jsonCors(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: name,
    },
    201
  );
}
