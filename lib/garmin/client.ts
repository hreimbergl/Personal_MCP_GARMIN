// Cliente HTTP para la Garmin Connect Personal API.
// Intercambia GARMIN_API_KEY por un access token (válido 24 h, sin refresh token)
// y lo reutiliza mientras la instancia de la función siga caliente.

const DEFAULT_BASE_URL = "https://personal.connectapi.garmin.com";
const TOKEN_PATH =
  "/personalapitoken-service/personal-api/personal-api-key/token";
// Garmin documenta 24 h de vigencia; renovamos con margen.
const DEFAULT_TOKEN_TTL_MS = 23 * 60 * 60 * 1000;
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export type QueryValue = string | number | boolean | string[] | undefined;

export class GarminApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "GarminApiError";
  }
}

type CachedToken = { value: string; scheme: string; expiresAt: number };

let cachedToken: CachedToken | undefined;
let pendingToken: Promise<CachedToken> | undefined;

function baseUrl(): string {
  return (process.env.GARMIN_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function apiKey(): string {
  const key = process.env.GARMIN_API_KEY?.trim();
  if (!key) {
    throw new GarminApiError(
      "Falta la variable de entorno GARMIN_API_KEY. Configúrala en Vercel.",
      500,
    );
  }
  return key;
}

// El formato de la respuesta del token no está documentado: aceptamos texto
// plano o JSON con los nombres de campo más habituales.
function parseTokenResponse(raw: string): CachedToken {
  const now = Date.now();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    data = raw.trim();
  }

  if (typeof data === "string" && data.length > 0) {
    return { value: data, scheme: "Bearer", expiresAt: now + DEFAULT_TOKEN_TTL_MS };
  }

  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const value = [obj.accessToken, obj.access_token, obj.token].find(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    if (value) {
      const scheme =
        typeof obj.tokenType === "string"
          ? obj.tokenType
          : typeof obj.token_type === "string"
            ? obj.token_type
            : "Bearer";
      let expiresAt = now + DEFAULT_TOKEN_TTL_MS;
      const expiresIn = Number(obj.expiresIn ?? obj.expires_in);
      const expiresAtRaw = obj.expiresAt ?? obj.expires_at ?? obj.expirationDate;
      if (Number.isFinite(expiresIn) && expiresIn > 0) {
        expiresAt = now + expiresIn * 1000;
      } else if (expiresAtRaw !== undefined) {
        const parsed =
          typeof expiresAtRaw === "number"
            ? expiresAtRaw < 1e12
              ? expiresAtRaw * 1000
              : expiresAtRaw
            : Date.parse(String(expiresAtRaw));
        if (Number.isFinite(parsed)) expiresAt = parsed;
      }
      return { value, scheme: normalizeScheme(scheme), expiresAt };
    }
  }

  throw new GarminApiError(
    "Garmin respondió al pedido de token sin un access token reconocible.",
    502,
  );
}

function normalizeScheme(scheme: string): string {
  return scheme.toLowerCase() === "bearer" ? "Bearer" : scheme;
}

async function requestToken(): Promise<CachedToken> {
  const res = await fetch(`${baseUrl()}${TOKEN_PATH}`, {
    method: "POST",
    // El endpoint responde 406 si se pide application/json: el token no viene como JSON.
    headers: { Authorization: `ApiKey ${apiKey()}`, Accept: "*/*" },
    cache: "no-store",
  });
  const body = await res.text();
  if (!res.ok) {
    throw new GarminApiError(
      `No se pudo obtener el access token de Garmin (HTTP ${res.status}). ` +
        "Revisa que GARMIN_API_KEY sea válida y no haya expirado.",
      res.status,
      body.slice(0, 500),
    );
  }
  return parseTokenResponse(body);
}

async function getToken(forceRefresh = false): Promise<CachedToken> {
  if (
    !forceRefresh &&
    cachedToken &&
    cachedToken.expiresAt - EXPIRY_MARGIN_MS > Date.now()
  ) {
    return cachedToken;
  }
  // Evita pedir varios tokens en paralelo cuando llegan llamadas simultáneas.
  pendingToken ??= requestToken()
    .then((token) => {
      cachedToken = token;
      return token;
    })
    .finally(() => {
      pendingToken = undefined;
    });
  return pendingToken;
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(`${baseUrl()}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, item);
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function garminFetch(
  path: string,
  query: Record<string, QueryValue> | undefined,
  accept: string,
): Promise<Response> {
  const url = buildUrl(path, query);
  const send = async (token: CachedToken) =>
    fetch(url, {
      headers: { Authorization: `${token.scheme} ${token.value}`, Accept: accept },
      cache: "no-store",
    });

  let res = await send(await getToken());
  // El token pudo revocarse o expirar antes de lo previsto: reintenta una vez.
  if (res.status === 401) {
    res = await send(await getToken(true));
  }
  if (!res.ok && res.status !== 204) {
    const body = await res.text().catch(() => "");
    throw new GarminApiError(
      `Garmin respondió HTTP ${res.status} para ${path}.`,
      res.status,
      body.slice(0, 1000),
    );
  }
  return res;
}

/** GET que devuelve JSON, o `null` si Garmin responde sin contenido. */
export async function garminGetJson(
  path: string,
  query?: Record<string, QueryValue>,
): Promise<unknown> {
  const res = await garminFetch(path, query, "application/json");
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** GET que devuelve un archivo binario. */
export async function garminGetBinary(
  path: string,
): Promise<{ data: ArrayBuffer; contentType: string; filename?: string }> {
  const res = await garminFetch(path, undefined, "*/*");
  const disposition = res.headers.get("content-disposition") ?? "";
  const filename = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
  return {
    data: await res.arrayBuffer(),
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
    filename,
  };
}
