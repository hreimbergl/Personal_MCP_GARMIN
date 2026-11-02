export default function Home() {
  return (
    <main style={{ maxWidth: 640 }}>
      <h1>Garmin Personal MCP</h1>
      <p>
        Servidor MCP activo. Conecta tu cliente a <code>/api/mcp</code> usando el token definido en{" "}
        <code>MCP_AUTH_TOKEN</code>.
      </p>
    </main>
  );
}
