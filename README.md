# Garmin Personal MCP

Servidor MCP (Model Context Protocol) para la [Garmin Connect Personal API](https://developer.garmin.com/gc-developer-program/personal/personal-api/), listo para desplegar en Vercel. Expone tus datos de Garmin Connect (actividades, sueño, HRV, Body Battery, estrés, peso, nutrición, etc.) como herramientas de solo lectura para Claude u otro cliente MCP.

- Next.js (App Router) + [`mcp-handler`](https://www.npmjs.com/package/mcp-handler) con transporte Streamable HTTP, sin estado.
- Endpoint: `https://<tu-proyecto>.vercel.app/api/mcp`
- La API key se intercambia automáticamente por un access token (válido 24 h). El token queda en caché mientras la función siga activa y se renueva solo.

## Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `GARMIN_API_KEY` | Sí | Personal API Key creada en [Garmin Connect › Personal API Key](https://connect.garmin.com/app/settings/personalApiToken). |
| `MCP_AUTH_TOKEN` | Sí | Secreto que deben presentar los clientes MCP. Protege tus datos de salud: sin él, cualquiera con la URL podría leerlos. Genera uno con `openssl rand -hex 32`. |
| `GARMIN_API_BASE_URL` | No | Por defecto `https://personal.connectapi.garmin.com`. Usa `https://personal.connectapi.garmin.cn` para cuentas de Garmin China. |

Si falta `MCP_AUTH_TOKEN`, el endpoint responde 500 y no atiende pedidos.

## Despliegue en Vercel

1. Sube este repositorio a GitHub e impórtalo en Vercel (framework: Next.js, sin configuración adicional).
2. En **Settings › Environment Variables** agrega `GARMIN_API_KEY` y `MCP_AUTH_TOKEN`.
3. Despliega. Al abrir la URL raíz verás una página de estado.

Con la CLI: `vercel env add GARMIN_API_KEY`, `vercel env add MCP_AUTH_TOKEN` y luego `vercel --prod`.

> Tu API key de Garmin expira (30, 90, 180 días o 1 año, según lo que elegiste). Cuando la renueves, actualiza `GARMIN_API_KEY` en Vercel y vuelve a desplegar.

## Conectar un cliente

El token se acepta de dos formas:

- Header `Authorization: Bearer <MCP_AUTH_TOKEN>` (preferido).
- Parámetro `?token=<MCP_AUTH_TOKEN>` en la URL, para clientes que no permiten headers propios.

**Claude (web/escritorio): conector personalizado**

En *Settings › Connectors › Add custom connector*, usa como URL:

```
https://<tu-proyecto>.vercel.app/api/mcp?token=<MCP_AUTH_TOKEN>
```

**Claude Code**

```bash
claude mcp add --transport http garmin https://<tu-proyecto>.vercel.app/api/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

**Clientes que solo soportan stdio** (vía `mcp-remote`):

```json
{
  "mcpServers": {
    "garmin": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "https://<tu-proyecto>.vercel.app/api/mcp",
        "--header", "Authorization: Bearer <MCP_AUTH_TOKEN>"
      ]
    }
  }
}
```

## Herramientas

Las fechas siempre van en formato `YYYY-MM-DD`. Los límites de rango son los que documenta Garmin y se validan antes de llamar a la API.

| Herramienta | Endpoint de Garmin | Notas |
|---|---|---|
| `search_activities` | `GET /activitylist-service/activities/search/activities` | Filtros por fecha, tipo, distancia, duración, desnivel, potencia, zona geográfica y buceo; paginación con `start`/`limit` |
| `get_activity` | `GET /activity-service/activity/{activityId}` | |
| `get_activity_workouts` | `GET /activity-service/activity/{activityId}/workouts` | |
| `download_activity_file` | `GET /download-service/files/activity/{activityId}` | ZIP original en base64, máx. 3 MB |
| `get_wellness_activity_summaries` | `GET /wellnessactivity-service/activity/summary/range/{from}/{until}` | |
| `get_daily_summary` | `GET /usersummary-service/usersummary/daily` | |
| `get_daily_summaries` | `GET /usersummary-service/v2/dailysummaries` | máx. 1 año |
| `get_steps` | `GET /usersummary-service/stats/steps/daily/{start}/{end}` | máx. 28 días |
| `get_stress` | `GET /usersummary-service/stats/stress/daily/{start}/{end}` | máx. 28 días |
| `get_hydration` | `GET /usersummary-service/stats/hydration/daily/{start}/{end}` | máx. 31 días |
| `get_sleep` | `GET /sleep-service/sleep/dailySleep` | |
| `get_sleep_summaries` | `GET /sleep-service/sleep/dailySleepSummariesByDate` | máx. 31 días |
| `get_hrv` | `GET /hrv-service/hrv/{date}` | |
| `get_hrv_range` | `GET /hrv-service/hrv/daily/{from}/{to}` | |
| `get_heart_rate` | `GET /wellness-service/wellness/dailyHeartRate` | |
| `get_body_battery` | `GET /wellness-service/wellness/bodyBattery/reports/daily` | máx. 31 días |
| `get_spo2` | `GET /wellness-service/wellness/daily/spo2acclimation/{date}` | |
| `get_heart_rate_zones` | `GET /biometric-service/heartRateZones/v2` | |
| `get_fitness_age` | `GET /fitnessage-service/fitnessage/v2/{date}` | |
| `get_weight_range` | `GET /weight-service/weight/range/{start}/{end}` | |
| `get_weight_entries` | `GET /weight-service/weight/all/{start}/{end}` | |
| `get_weight_goals` | `GET /goal-service/goal/user/effective/weightgoal/{start}/{end}` | |
| `get_nutrition_log` | `GET /nutrition-service/food/logs/{date}` | |
| `get_menstrual_cycle_summary` | `GET /periodichealth-service/menstrualcycle/summary/{date}` | |
| `get_menstrual_cycle_day` | `GET /periodichealth-service/menstrualcycle/dayview/{date}` | |
| `get_user_profile_settings` | `GET /userprofile-service/userprofile/settings` | |

## Desarrollo local

```bash
cp .env.example .env.local   # completa GARMIN_API_KEY y MCP_AUTH_TOKEN
npm install
npm run dev                  # http://localhost:3000/api/mcp
```

Puedes probarlo con el inspector oficial: `npx @modelcontextprotocol/inspector` (transporte *Streamable HTTP*, URL `http://localhost:3000/api/mcp?token=...`).

## Supuestos sobre la API

La documentación de Garmin no especifica el formato de respuesta del endpoint de token ni el esquema de autorización de los endpoints de datos. El cliente ([lib/garmin/client.ts](lib/garmin/client.ts)):

- acepta el token como texto plano o JSON (`accessToken`, `access_token` o `token`, con `expiresIn`/`expires_in` opcional);
- lo envía como `Authorization: Bearer <token>`, salvo que la respuesta indique otro `tokenType`;
- si una llamada responde 401, pide un token nuevo y reintenta una vez.

Si tu primera llamada real falla con 401 o 403, revisa los logs de la función en Vercel: el mensaje de error incluye la respuesta de Garmin.

## Estructura

```
app/api/mcp/route.ts   Endpoint MCP (GET/POST) protegido por MCP_AUTH_TOKEN
lib/auth.ts            Verificación del secreto compartido
lib/garmin/client.ts   Token, caché y llamadas HTTP a Garmin
lib/garmin/tools.ts    Definición de las 26 herramientas MCP
```
