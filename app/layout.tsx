export const metadata = {
  title: "Garmin Personal MCP",
  description: "Servidor MCP para la Garmin Connect Personal API",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: 24 }}>{children}</body>
    </html>
  );
}
