import { Redis } from "@upstash/redis";

// Vercel inyecta estas variables al conectar Upstash for Redis al proyecto
const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

const CLAVE_ULTIMO = "penales:ultimo";
const CLAVE_CONTADOR = "penales:jugador";
const CLAVE_HISTORIAL = "penales:historial";
const RESULTADOS = new Set(["vacio", "goal", "atajado"]);
const SIN_DATOS = { version: 0, jugador: 0, tiros: [] };

function responder(datos, estado = 200) {
  return new Response(JSON.stringify(datos), {
    status: estado,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// El panel consulta aqui el resultado del ultimo jugador
export async function GET() {
  const ultimo = await redis.get(CLAVE_ULTIMO);
  return responder(ultimo ?? SIN_DATOS);
}

// El juego publica aqui cuando el jugador termina su tanda
export async function POST(request) {
  const token = process.env.PANEL_TOKEN;
  if (!token || request.headers.get("authorization") !== `Bearer ${token}`) {
    return responder({ error: "Token invalido" }, 401);
  }

  let cuerpo;
  try {
    cuerpo = await request.json();
  } catch {
    return responder({ error: "JSON invalido" }, 400);
  }

  const tiros = cuerpo?.tiros;
  const valido =
    Array.isArray(tiros) &&
    tiros.length > 0 &&
    tiros.length <= 20 &&
    tiros.every((t) => Number.isInteger(t?.n) && RESULTADOS.has(t?.r));
  if (!valido) {
    return responder({ error: "Formato de tiros invalido" }, 400);
  }

  const ordenados = tiros.map(({ n, r }) => ({ n, r })).sort((a, b) => a.n - b.n);
  const jugador = await redis.incr(CLAVE_CONTADOR);
  const ahora = new Date();

  const resultado = {
    version: jugador,
    jugador,
    hora: ahora.toLocaleTimeString("es-EC", {
      timeZone: "America/Guayaquil",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }),
    fecha: ahora.toISOString(),
    atajados: ordenados.filter((t) => t.r === "atajado").length,
    goles: ordenados.filter((t) => t.r === "goal").length,
    tiros: ordenados,
  };

  const lote = redis.pipeline();
  lote.set(CLAVE_ULTIMO, resultado);
  lote.lpush(CLAVE_HISTORIAL, resultado); // registro de todos los jugadores (ultimos 2000)
  lote.ltrim(CLAVE_HISTORIAL, 0, 1999);
  await lote.exec();

  return responder(resultado);
}
