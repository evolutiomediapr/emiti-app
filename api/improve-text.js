const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const ALLOWED_ORIGIN = 'https://emiti-app.vercel.app';
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TEXT_CHARS = 600;   // tope de entrada (una descripción de línea)
const MAX_OUT_CHARS  = 200;   // tope de salida tras sanear

// Prompts por tipo de texto. En Fase 1 solo existe 'line'; 'notes' es drop-in.
const PROMPTS = {
  line: `Eres un asistente que mejora descripciones de servicios para las facturas y cotizaciones de un contratista o negocio de servicios en Puerto Rico. Reescribes el texto del usuario en español natural, claro y profesional, con un tono cercano de contratista a su cliente.

Reglas estrictas:
- Devuelve solo la descripción mejorada, sin comillas, sin explicaciones y sin viñetas.
- NO inventes información. No agregues materiales, marcas, cantidades, medidas, precios, fechas ni detalles que el usuario no haya escrito. Solo mejora la claridad, la gramática, la ortografía y el profesionalismo de lo que ya está.
- Conserva el idioma original (normalmente español). No traduzcas.
- Conserva el significado exacto. Si el texto es corto o vago, mejóralo sin especular sobre qué se hizo.
- Sé conciso: es una línea de descripción de factura, no un párrafo. Nunca más de ~120 caracteres.

Ejemplos:
Original: arreglé el baño
Mejorado: Reparación en el baño

Original: puse 2 tomas nuevas en la cocina
Mejorado: Instalación de 2 tomacorrientes nuevos en la cocina

Original: pintura
Mejorado: Trabajo de pintura`
};

// Structured output: garantiza JSON parseable con exactamente este campo.
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['improved'],
  properties: {
    improved: { type: 'string', description: 'La descripción mejorada, en español, sin comillas ni explicaciones.' }
  }
};

// Saneo: quita comillas envolventes y acota el largo. null si no es texto útil.
function sanitizeImproved(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!t) return null;
  return t.slice(0, MAX_OUT_CHARS);
}

// Parseo puro de la respuesta de Claude -> { ok, improved }. Testeable offline
// (mockeando `msg`), sin llamar a la API. Cubre refusal / vacío / JSON inválido.
function parseImproveResponse(msg) {
  if (!msg || msg.stop_reason === 'refusal' || !msg.content || !msg.content.length) return { ok: false };
  const textBlock = msg.content.find(b => b.type === 'text');
  if (!textBlock || typeof textBlock.text !== 'string') return { ok: false };
  let out;
  try { out = JSON.parse(textBlock.text); } catch { return { ok: false }; }
  const improved = sanitizeImproved(out && out.improved);
  if (!improved) return { ok: false };
  return { ok: true, improved };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 1) Usuario desde el bearer token (mismo patrón que scan-receipt.js)
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: { user }, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Token inválido' });

  // 2) Gate Pro server-side: la llamada a Claude cuesta dinero — el gate del
  //    cliente no basta. profiles.plan solo lo escribe service_role.
  const { data: profile, error: profErr } = await admin
    .from('profiles').select('plan').eq('id', user.id).single();
  if (profErr) {
    console.error('[improve-text] profiles:', profErr.message);
    return res.status(500).json({ error: 'Error verificando el plan' });
  }
  if (profile?.plan !== 'pro') {
    return res.status(403).json({ error: 'La mejora con IA es función Pro' });
  }

  // 3) Entrada: texto del usuario + tipo. Solo 'line' en Fase 1.
  const { text, kind = 'line' } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text requerido' });
  }
  if (text.length > MAX_TEXT_CHARS) {
    return res.status(413).json({ error: 'Texto demasiado largo' });
  }
  const prompt = PROMPTS[kind];
  if (!prompt) return res.status(400).json({ error: 'kind inválido' });

  // 4) Mejora con Haiku + structured output. Stateless: no persiste nada.
  try {
    const client = new Anthropic(); // ANTHROPIC_API_KEY del entorno
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 256,
      system: prompt,
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: `Mejora esta descripción:\n\n${text.trim()}` }]
      }]
    });

    const parsed = parseImproveResponse(msg);
    if (!parsed.ok) return res.status(502).json({ error: 'No se pudo mejorar el texto' });
    return res.json({ improved: parsed.improved });
  } catch (e) {
    console.error('[improve-text] mejora falló:', e.message);
    return res.status(502).json({ error: 'No se pudo mejorar el texto' });
  }
};

// Exportado para tests offline (mockeando la respuesta de Claude).
module.exports._internals = { parseImproveResponse, sanitizeImproved, PROMPTS, SCHEMA, MODEL, MAX_TEXT_CHARS, MAX_OUT_CHARS };
