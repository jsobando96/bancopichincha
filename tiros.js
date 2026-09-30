import { Redis } from "@upstash/redis";

// Vercel inyecta estas variables al conectar Upstash for Redis al proyecto
const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

const CLAVE_ACTUAL = "penales:ultimo";
const CLAVE_CONTADOR = "penales:jugador";
const CLAVE_HISTORIAL = "penales:historial";
const RESULTADOS = new Set(["vacio", "goal", "atajado"]);
const SIN_DATOS = { version: "", jugador: 0, tiros: [] };

function responder(datos, estado = 200) {
  return new Response(JSON.stringify(datos), {
    status: estado,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// El panel consulta aqui la tanda actual (en juego o la ultima terminada)
export async function GET() {
  const actual = await redis.get(CLAVE_ACTUAL);
  return responder(actual ?? SIN_DATOS);
}

// El juego publica aqui al empezar la tanda, despues de cada tiro y al terminar
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

  const { id, secuencia, terminado, tiros } = cuerpo ?? {};
  const valido =
    typeof id === "string" &&
    /^[A-Za-z0-9-]{1,64}$/.test(id) &&
    Number.isInteger(secuencia) &&
    secuencia > 0 &&
    typeof terminado === "boolean" &&
    Array.isArray(tiros) &&
    tiros.length <= 20 &&
    tiros.every((t) => Number.isInteger(t?.n) && RESULTADOS.has(t?.r));
  if (!valido) {
    return responder({ error: "Formato invalido" }, 400);
  }

  const actual = await redis.get(CLAVE_ACTUAL);
  let jugador;
  if (actual?.id === id) {
    // Reintento repetido o actualizacion atrasada: ya se mostro algo igual o mas nuevo
    if (secuencia <= actual.secuencia) {
      return responder({ ...actual, ignorado: true });
    }
    jugador = actual.jugador;
  } else {
    jugador = await redis.incr(CLAVE_CONTADOR);
  }

  const ordenados = tiros.map(({ n, r }) => ({ n, r })).sort((a, b) => a.n - b.n);
  const ahora = new Date();

  const resultado = {
    version: `${id}:${secuencia}`,
    id,
    secuencia,
    jugador,
    estado: terminado ? "terminado" : "en_juego",
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
  lote.set(CLAVE_ACTUAL, resultado);
  if (terminado) {
    lote.lpush(CLAVE_HISTORIAL, resultado); // registro de jugadores terminados (ultimos 2000)
    lote.ltrim(CLAVE_HISTORIAL, 0, 1999);
  }
  await lote.exec();

  return responder(resultado);
}
