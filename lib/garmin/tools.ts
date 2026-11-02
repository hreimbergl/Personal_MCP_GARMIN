import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  GarminApiError,
  garminGetBinary,
  garminGetJson,
  type QueryValue,
} from "./client";

// Las respuestas binarias viajan en base64 dentro de la respuesta de la función;
// Vercel limita el cuerpo a ~4,5 MB.
const MAX_DOWNLOAD_BYTES = 3 * 1024 * 1024;

const date = (description: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Usa el formato YYYY-MM-DD")
    .describe(description);

const activityId = z
  .number()
  .int()
  .positive()
  .describe("ID numérico de la actividad (campo activityId de search_activities).");

type ToolResult = {
  content: (
    | { type: "text"; text: string }
    | {
        type: "resource";
        resource: { uri: string; mimeType: string; blob: string };
      }
  )[];
  isError?: boolean;
};

function daysBetween(start: string, end: string): number {
  return (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000;
}

/** Valida un rango inclusivo contra el máximo de días que admite el endpoint. */
function checkRange(start: string, end: string, maxDays?: number): void {
  const diff = daysBetween(start, end);
  if (!Number.isFinite(diff)) throw new Error("Fecha inválida.");
  if (diff < 0) throw new Error("La fecha de inicio debe ser anterior o igual a la de término.");
  if (maxDays !== undefined && diff + 1 > maxDays) {
    throw new Error(`Este endpoint admite como máximo ${maxDays} días por consulta.`);
  }
}

function errorResult(err: unknown): ToolResult {
  let text = err instanceof Error ? err.message : String(err);
  if (err instanceof GarminApiError && err.body) {
    text += `\nRespuesta de Garmin: ${err.body}`;
  }
  return { content: [{ type: "text", text }], isError: true };
}

function jsonResult(data: unknown): ToolResult {
  if (data === null || data === undefined) {
    return { content: [{ type: "text", text: "Garmin no devolvió datos para esta consulta." }] };
  }
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

type Request = { path: string; query?: Record<string, QueryValue>; range?: [string, string, number?] };

/** Registra una herramienta de solo lectura que mapea a un GET JSON de Garmin. */
function getTool<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  title: string,
  description: string,
  shape: S,
  toRequest: (args: z.infer<z.ZodObject<S>>) => Request,
): void {
  server.registerTool(
    name,
    {
      title,
      description,
      inputSchema: z.object(shape),
      annotations: { title, ...readOnly },
    },
    async (args: z.infer<z.ZodObject<S>>): Promise<ToolResult> => {
      try {
        const req = toRequest(args);
        if (req.range) checkRange(...req.range);
        return jsonResult(await garminGetJson(req.path, req.query));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

const enc = encodeURIComponent;

export function registerGarminTools(server: McpServer): void {
  // ───────────── Actividades ─────────────

  getTool(
    server,
    "search_activities",
    "Buscar actividades",
    "Busca actividades registradas en Garmin Connect con filtros opcionales y paginación. " +
      "Devuelve resúmenes (activityId, nombre, tipo, fecha, distancia, duración, FC, etc.). " +
      "Úsala para encontrar el activityId que necesitan get_activity y get_activity_workouts.",
    {
      start: z.number().int().min(0).optional().describe("Desplazamiento (offset) desde 0. Por defecto 0."),
      limit: z.number().int().min(1).max(99).optional().describe("Cantidad máxima de resultados. Por defecto 99."),
      startDate: date("Fecha local de inicio mínima (inclusive), YYYY-MM-DD.").optional(),
      endDate: date("Fecha local de inicio máxima (inclusive), YYYY-MM-DD.").optional(),
      search: z.string().optional().describe("Texto a buscar en el nombre y la descripción."),
      activityType: z.string().optional().describe("Tipo padre, p. ej. running, cycling, swimming."),
      activitySubType: z.string().optional().describe("Subtipo, p. ej. trail_running, road_biking."),
      excludedActivitySubType: z.array(z.string()).optional().describe("Subtipos a excluir."),
      eventType: z
        .enum(["race", "training", "recreation", "fitness", "specialEvent", "uncategorized"])
        .optional()
        .describe("Clasificación del evento."),
      favorite: z.boolean().optional().describe("true: solo favoritas; false: solo no favoritas."),
      sortBy: z.string().optional().describe("Campo de orden (name, distance, duration...). Por defecto startLocal."),
      sortOrder: z.enum(["asc", "desc"]).optional().describe("Dirección del orden. Por defecto desc."),
      excludeChildren: z.boolean().optional().describe("Excluir sub-actividades (tramos de multisport). Por defecto true."),
      minDistance: z.number().int().optional().describe("Distancia mínima en metros."),
      maxDistance: z.number().int().optional().describe("Distancia máxima en metros."),
      minDuration: z.number().int().optional().describe("Duración (timer) mínima en segundos."),
      maxDuration: z.number().int().optional().describe("Duración (timer) máxima en segundos."),
      minElapsedDuration: z.number().int().optional().describe("Duración total mínima con pausas, en segundos."),
      maxElapsedDuration: z.number().int().optional().describe("Duración total máxima con pausas, en segundos."),
      minElevation: z.number().int().optional().describe("Desnivel positivo mínimo en metros."),
      maxElevation: z.number().int().optional().describe("Desnivel positivo máximo en metros."),
      minAvgPower: z.number().int().optional().describe("Potencia media mínima en watts."),
      requiredField: z.array(z.string()).optional().describe("Campos que deben tener valor no nulo."),
      upperLatitude: z.number().optional().describe("Límite norte del área de inicio (requiere los 4 límites)."),
      lowerLatitude: z.number().optional().describe("Límite sur del área de inicio."),
      leftLongitude: z.number().optional().describe("Límite oeste del área de inicio."),
      rightLongitude: z.number().optional().describe("Límite este del área de inicio."),
      lowerMaxDepth: z.number().int().optional().describe("Buceo: profundidad máxima mínima en cm."),
      upperMaxDepth: z.number().int().optional().describe("Buceo: profundidad máxima máxima en cm."),
      decoDive: z.boolean().optional().describe("Buceo: true solo descompresión, false solo sin descompresión."),
      minBottomTime: z.number().int().optional().describe("Buceo: tiempo de fondo mínimo en segundos."),
      maxBottomTime: z.number().int().optional().describe("Buceo: tiempo de fondo máximo en segundos."),
    },
    ({ favorite, ...rest }) => ({
      path: "/activitylist-service/activities/search/activities",
      query: { ...rest, favorite: favorite === undefined ? undefined : favorite ? 1 : 0 },
    }),
  );

  getTool(
    server,
    "get_activity",
    "Detalle de actividad",
    "Resumen completo de una actividad: metadatos, mediciones y resumen de splits.",
    { activityId },
    ({ activityId }) => ({ path: `/activity-service/activity/${activityId}` }),
  );

  getTool(
    server,
    "get_activity_workouts",
    "Entrenamientos de una actividad",
    "Entrenamientos estructurados (workouts) realizados durante una actividad.",
    { activityId },
    ({ activityId }) => ({ path: `/activity-service/activity/${activityId}/workouts` }),
  );

  getTool(
    server,
    "get_wellness_activity_summaries",
    "Resúmenes de actividades de bienestar",
    "Lista de resúmenes de actividades de bienestar entre dos fechas (ambas inclusive).",
    {
      fromDate: date("Fecha inicial, YYYY-MM-DD."),
      untilDate: date("Fecha final, YYYY-MM-DD."),
    },
    ({ fromDate, untilDate }) => ({
      path: `/wellnessactivity-service/activity/summary/range/${enc(fromDate)}/${enc(untilDate)}`,
      range: [fromDate, untilDate],
    }),
  );

  server.registerTool(
    "download_activity_file",
    {
      title: "Descargar archivo de actividad",
      description:
        "Descarga el archivo original de una actividad (ZIP, normalmente con un .FIT) " +
        `y lo devuelve como recurso embebido en base64. Límite: ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB.`,
      inputSchema: z.object({ activityId }),
      annotations: { title: "Descargar archivo de actividad", ...readOnly },
    },
    async ({ activityId }: { activityId: number }): Promise<ToolResult> => {
      try {
        const file = await garminGetBinary(`/download-service/files/activity/${activityId}`);
        if (file.data.byteLength > MAX_DOWNLOAD_BYTES) {
          throw new Error(
            `El archivo pesa ${(file.data.byteLength / 1024 / 1024).toFixed(1)} MB y supera ` +
              "el límite que puede devolver una función de Vercel.",
          );
        }
        const filename = file.filename ?? `activity_${activityId}.zip`;
        return {
          content: [
            {
              type: "text",
              text: `Archivo ${filename} (${file.data.byteLength} bytes, ${file.contentType}).`,
            },
            {
              type: "resource",
              resource: {
                uri: `garmin://activity/${activityId}/file/${enc(filename)}`,
                mimeType: file.contentType,
                blob: Buffer.from(file.data).toString("base64"),
              },
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ───────────── Resumen diario ─────────────

  getTool(
    server,
    "get_daily_summary",
    "Resumen diario",
    "Resumen de bienestar de un día: pasos, calorías, estrés, Body Battery, FC en reposo y otras métricas.",
    { calendarDate: date("Día a consultar, YYYY-MM-DD.") },
    ({ calendarDate }) => ({
      path: "/usersummary-service/usersummary/daily",
      query: { calendarDate },
    }),
  );

  getTool(
    server,
    "get_daily_summaries",
    "Resúmenes diarios por rango",
    "Resúmenes diarios de bienestar para un rango de fechas (máximo 1 año).",
    {
      startDate: date("Fecha inicial, YYYY-MM-DD."),
      endDate: date("Fecha final, YYYY-MM-DD."),
    },
    ({ startDate, endDate }) => ({
      path: "/usersummary-service/v2/dailysummaries",
      query: { startDate, endDate },
      range: [startDate, endDate, 366],
    }),
  );

  getTool(
    server,
    "get_steps",
    "Pasos diarios",
    "Pasos diarios para un rango de fechas (máximo 28 días).",
    {
      startDate: date("Fecha inicial, YYYY-MM-DD."),
      endDate: date("Fecha final, YYYY-MM-DD."),
    },
    ({ startDate, endDate }) => ({
      path: `/usersummary-service/stats/steps/daily/${enc(startDate)}/${enc(endDate)}`,
      range: [startDate, endDate, 28],
    }),
  );

  getTool(
    server,
    "get_stress",
    "Estrés diario",
    "Niveles de estrés diarios para un rango de fechas (máximo 28 días).",
    {
      startDate: date("Fecha inicial, YYYY-MM-DD."),
      endDate: date("Fecha final, YYYY-MM-DD."),
    },
    ({ startDate, endDate }) => ({
      path: `/usersummary-service/stats/stress/daily/${enc(startDate)}/${enc(endDate)}`,
      range: [startDate, endDate, 28],
    }),
  );

  getTool(
    server,
    "get_hydration",
    "Hidratación diaria",
    "Datos de hidratación diarios para un rango de fechas (máximo 31 días).",
    {
      startDate: date("Fecha inicial, YYYY-MM-DD."),
      endDate: date("Fecha final, YYYY-MM-DD."),
    },
    ({ startDate, endDate }) => ({
      path: `/usersummary-service/stats/hydration/daily/${enc(startDate)}/${enc(endDate)}`,
      range: [startDate, endDate, 31],
    }),
  );

  // ───────────── Sueño, HRV, FC, Body Battery, SpO2 ─────────────

  getTool(
    server,
    "get_sleep",
    "Sueño del día",
    "Datos de sueño detallados de una noche (fases, puntaje, duración, etc.).",
    { date: date("Día a consultar, YYYY-MM-DD.") },
    ({ date }) => ({ path: "/sleep-service/sleep/dailySleep", query: { date } }),
  );

  getTool(
    server,
    "get_sleep_summaries",
    "Resúmenes de sueño por rango",
    "Resúmenes diarios de sueño para un rango de fechas (máximo 31 días).",
    {
      startDate: date("Fecha inicial, YYYY-MM-DD."),
      endDate: date("Fecha final, YYYY-MM-DD."),
    },
    ({ startDate, endDate }) => ({
      path: "/sleep-service/sleep/dailySleepSummariesByDate",
      query: { startDate, endDate },
      range: [startDate, endDate, 31],
    }),
  );

  getTool(
    server,
    "get_hrv",
    "HRV del día",
    "Variabilidad de la frecuencia cardíaca (HRV) de un día, con lecturas nocturnas.",
    { calendarDate: date("Día a consultar, YYYY-MM-DD.") },
    ({ calendarDate }) => ({ path: `/hrv-service/hrv/${enc(calendarDate)}` }),
  );

  getTool(
    server,
    "get_hrv_range",
    "HRV por rango",
    "Resúmenes diarios de HRV para un rango de fechas.",
    {
      fromDate: date("Fecha inicial, YYYY-MM-DD."),
      toDate: date("Fecha final, YYYY-MM-DD."),
    },
    ({ fromDate, toDate }) => ({
      path: `/hrv-service/hrv/daily/${enc(fromDate)}/${enc(toDate)}`,
      range: [fromDate, toDate],
    }),
  );

  getTool(
    server,
    "get_heart_rate",
    "Frecuencia cardíaca del día",
    "Frecuencia cardíaca del día: reposo, mínimo, máximo y serie de lecturas. La respuesta puede ser extensa.",
    { date: date("Día a consultar, YYYY-MM-DD.") },
    ({ date }) => ({ path: "/wellness-service/wellness/dailyHeartRate", query: { date } }),
  );

  getTool(
    server,
    "get_body_battery",
    "Body Battery",
    "Reportes diarios de Body Battery para un rango de fechas (máximo 31 días).",
    {
      startDate: date("Fecha inicial, YYYY-MM-DD."),
      endDate: date("Fecha final, YYYY-MM-DD."),
      chunks: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Intervalos en que se divide cada día; devuelve mínimo y máximo de cada intervalo."),
    },
    ({ startDate, endDate, chunks }) => ({
      path: "/wellness-service/wellness/bodyBattery/reports/daily",
      query: { startDate, endDate, chunks },
      range: [startDate, endDate, 31],
    }),
  );

  getTool(
    server,
    "get_spo2",
    "SpO2 del día",
    "Lecturas de saturación de oxígeno (SpO2) y aclimatación de un día.",
    { calendarDate: date("Día a consultar, YYYY-MM-DD.") },
    ({ calendarDate }) => ({
      path: `/wellness-service/wellness/daily/spo2acclimation/${enc(calendarDate)}`,
    }),
  );

  getTool(
    server,
    "get_heart_rate_zones",
    "Zonas de frecuencia cardíaca",
    "Configuración de zonas de frecuencia cardíaca del usuario.",
    {
      generateDefaults: z
        .boolean()
        .optional()
        .describe("Generar zonas por defecto si no hay configuradas. Por defecto true."),
    },
    ({ generateDefaults }) => ({
      path: "/biometric-service/heartRateZones/v2",
      query: { generateDefaults },
    }),
  );

  getTool(
    server,
    "get_fitness_age",
    "Edad física",
    "Última edad física (Fitness Age) disponible a la fecha indicada.",
    {
      calendarDate: date("Fecha de referencia, YYYY-MM-DD."),
      fullHistoryScan: z
        .boolean()
        .optional()
        .describe("Buscar en todo el historial (true, por defecto) o solo en los últimos 28 días."),
    },
    ({ calendarDate, fullHistoryScan }) => ({
      path: `/fitnessage-service/fitnessage/v2/${enc(calendarDate)}`,
      query: { fullHistoryScan },
    }),
  );

  // ───────────── Peso y nutrición ─────────────

  getTool(
    server,
    "get_weight_range",
    "Peso por rango",
    "Resumen de peso para un rango: último peso de cada día, promedio del rango y pesos adyacentes.",
    {
      startDate: date("Fecha inicial, YYYY-MM-DD."),
      endDate: date("Fecha final, YYYY-MM-DD."),
      includeAll: z
        .boolean()
        .optional()
        .describe("Incluir todas las mediciones de cada día (por defecto solo la última)."),
    },
    ({ startDate, endDate, includeAll }) => ({
      path: `/weight-service/weight/range/${enc(startDate)}/${enc(endDate)}`,
      query: { includeAll },
      range: [startDate, endDate],
    }),
  );

  getTool(
    server,
    "get_weight_entries",
    "Mediciones de peso",
    "Todas las mediciones de peso registradas en un rango de fechas.",
    {
      startDate: date("Fecha inicial, YYYY-MM-DD."),
      endDate: date("Fecha final, YYYY-MM-DD."),
    },
    ({ startDate, endDate }) => ({
      path: `/weight-service/weight/all/${enc(startDate)}/${enc(endDate)}`,
      range: [startDate, endDate],
    }),
  );

  getTool(
    server,
    "get_weight_goals",
    "Metas de peso",
    "Metas de peso vigentes y rangos objetivo para un intervalo de fechas.",
    {
      startDate: date("Fecha inicial, YYYY-MM-DD."),
      endDate: date("Fecha final, YYYY-MM-DD."),
    },
    ({ startDate, endDate }) => ({
      path: `/goal-service/goal/user/effective/weightgoal/${enc(startDate)}/${enc(endDate)}`,
      range: [startDate, endDate],
    }),
  );

  getTool(
    server,
    "get_nutrition_log",
    "Registro de nutrición",
    "Resumen nutricional del día: metas, nutrientes consumidos y comidas registradas.",
    {
      date: date("Día a consultar (hora local del usuario), YYYY-MM-DD."),
      mealId: z.number().int().optional().describe("Filtrar por comida (desayuno, almuerzo, snacks, cena)."),
      includeGoals: z.boolean().optional().describe("Incluir metas. Por defecto true."),
      includeNutrition: z.boolean().optional().describe("Incluir información nutricional. Por defecto true."),
      includeMedia: z.boolean().optional().describe("Incluir imágenes. Por defecto true."),
    },
    ({ date, ...query }) => ({ path: `/nutrition-service/food/logs/${enc(date)}`, query }),
  );

  // ───────────── Salud femenina ─────────────

  getTool(
    server,
    "get_menstrual_cycle_summary",
    "Resumen del ciclo menstrual",
    "Resumen del ciclo menstrual vigente a una fecha.",
    { calendarDate: date("Fecha a consultar, YYYY-MM-DD.") },
    ({ calendarDate }) => ({
      path: `/periodichealth-service/menstrualcycle/summary/${enc(calendarDate)}`,
    }),
  );

  getTool(
    server,
    "get_menstrual_cycle_day",
    "Día del ciclo menstrual",
    "Detalle de un día del ciclo: síntomas, flujo, ánimo registrados, resumen del ciclo y, en embarazo, rangos de peso.",
    {
      calendarDate: date("Fecha a consultar, YYYY-MM-DD."),
      todayDate: date("Fecha 'hoy' de referencia para predicciones, YYYY-MM-DD.").optional(),
      reducedResponse: z.boolean().optional().describe("Respuesta reducida. Por defecto false."),
      skipbm: z.boolean().optional().describe("Excluir conteo de movimientos del bebé. Por defecto false."),
      includeAnalysis: z.boolean().optional().describe("Incluir análisis del ciclo. Por defecto false."),
    },
    ({ calendarDate, ...query }) => ({
      path: `/periodichealth-service/menstrualcycle/dayview/${enc(calendarDate)}`,
      query,
    }),
  );

  // ───────────── Perfil ─────────────

  getTool(
    server,
    "get_user_profile_settings",
    "Configuración del perfil",
    "Configuración del perfil del usuario (unidades, peso, altura, zonas horarias, etc.).",
    {},
    () => ({ path: "/userprofile-service/userprofile/settings" }),
  );
}
