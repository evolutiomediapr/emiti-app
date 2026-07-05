const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const ALLOWED_ORIGIN = 'https://emiti-app.vercel.app';
const MODEL = 'claude-haiku-4-5-20251001';
const CATEGORIES = ['Materiales', 'Transporte', 'Comidas', 'Herramientas', 'Oficina', 'Subcontratistas', 'Otros'];
// El cliente comprime a JPEG ~300 KB (base64 ~400 KB); 2 MB de margen holgado.
const MAX_B64_CHARS = 2_800_000;

// Structured outputs: el schema garantiza JSON parseable con exactamente estos
// campos. Los nullables van con anyOf (los arrays de type no están soportados).
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['merchant', 'date', 'total', 'tax', 'category'],
  properties: {
    merchant: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Nombre del comercio o proveedor' },
    date: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Fecha del recibo en formato YYYY-MM-DD' },
    total: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'Total final pagado' },
    tax: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'Impuestos (IVU/IVA/tax) si aparecen desglosados' },
    category: { type: 'string', enum: CATEGORIES }
  }
};

const PROMPT = `Extrae los datos de este recibo de compra para el registro de gastos de un pequeño negocio.
- merchant: nombre del comercio/proveedor tal como aparece.
- date: fecha del recibo (YYYY-MM-DD).
- total: el total FINAL pagado (no el subtotal).
- tax: impuestos desglosados (IVU, IVA, tax) si aparecen; null si no.
- category: la más apropiada entre ${CATEGORIES.join(', ')}. Si no estás seguro, usa "Otros".
Si un dato no aparece o no es legible, devuélvelo como null. No inventes valores.`;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 1) Usuario desde el bearer token (mismo patrón que activate-iap.js)
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
    console.error('[scan-receipt] profiles:', profErr.message);
    return res.status(500).json({ error: 'Error verificando el plan' });
  }
  if (profile?.plan !== 'pro') {
    return res.status(403).json({ error: 'El escaneo de recibos es función Pro' });
  }

  // 3) Imagen: base64 directo del cliente (comprimida con el pipeline v1.4).
  //    NO viene del bucket: el escaneo ocurre ANTES de guardar el gasto.
  const { image_b64 } = req.body || {};
  if (!image_b64 || typeof image_b64 !== 'string') {
    return res.status(400).json({ error: 'image_b64 requerido' });
  }
  if (image_b64.length > MAX_B64_CHARS) {
    return res.status(413).json({ error: 'Imagen demasiado grande' });
  }

  // 4) Extracción con Haiku + structured outputs
  try {
    const client = new Anthropic(); // ANTHROPIC_API_KEY del entorno
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image_b64 } },
          { type: 'text', text: PROMPT }
        ]
      }]
    });

    if (msg.stop_reason === 'refusal' || !msg.content?.length) {
      return res.status(502).json({ error: 'No se pudo leer el recibo' });
    }
    const textBlock = msg.content.find(b => b.type === 'text');
    const out = JSON.parse(textBlock.text);

    // 5) Saneo defensivo (el schema ya garantiza la forma; esto acota valores)
    const dateOk = typeof out.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(out.date);
    return res.json({
      merchant: typeof out.merchant === 'string' ? out.merchant.slice(0, 120) : null,
      date: dateOk ? out.date : null,
      total: typeof out.total === 'number' && out.total >= 0 ? out.total : null,
      tax: typeof out.tax === 'number' && out.tax >= 0 ? out.tax : null,
      category: CATEGORIES.includes(out.category) ? out.category : 'Otros'
    });
  } catch (e) {
    console.error('[scan-receipt] extracción falló:', e.message);
    return res.status(502).json({ error: 'No se pudo leer el recibo' });
  }
};

// Exportado para tests offline.
module.exports._internals = { SCHEMA, CATEGORIES, MODEL, MAX_B64_CHARS };
