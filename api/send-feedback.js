const { createClient } = require('@supabase/supabase-js');

const ALLOWED_ORIGIN = 'https://emiti-app.vercel.app';
// Destinatario del feedback: configurable por env var, con fallback fijo.
const FEEDBACK_TO = process.env.FEEDBACK_TO || 'evolutiomediapr@gmail.com';
const MAX_MESSAGE_CHARS = 2000;
const MAX_META_CHARS = 120;      // tope defensivo para campos informativos
const SUBJECT_PREVIEW_CHARS = 60;

// Categorías válidas -> etiqueta del asunto y nombre para el cuerpo.
const CATEGORIES = {
  problema:   { tag: '[Problema]',   nombre: 'Problema' },
  sugerencia: { tag: '[Sugerencia]', nombre: 'Sugerencia' },
  pregunta:   { tag: '[Pregunta]',   nombre: 'Pregunta' }
};

// Saneo de campos informativos: una sola línea, sin controles, largo acotado.
// El email va en texto plano, así que no hace falta escapar HTML.
function clean(s, max = MAX_META_CHARS) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 1) Usuario desde el bearer token (mismo patrón que improve-text.js).
  //    El Reply-To sale SIEMPRE del JWT verificado, nunca del body.
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: { user }, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Token inválido' });
  if (!user.email) return res.status(403).json({ error: 'Tu cuenta no tiene un correo asociado' });

  // 2) Entrada: categoría + mensaje obligatorios; el resto es informativo.
  const { category, message, name, biz, context } = req.body || {};
  const cat = CATEGORIES[category];
  if (!cat) return res.status(400).json({ error: 'Categoría inválida' });
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Escribe un mensaje antes de enviar' });
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return res.status(413).json({ error: 'El mensaje es demasiado largo' });
  }
  const msg = message.trim();

  // Contexto técnico reportado por el cliente: solo para triage, no se confía
  // en él para nada más (el dato verificado es user.email / user.id).
  const ctx = context || {};
  const version  = clean(ctx.version)  || 'desconocida';
  const platform = clean(ctx.platform) || 'desconocida';
  const plan     = clean(ctx.plan)     || 'desconocido';
  const quien = [clean(name), clean(biz) ? `(${clean(biz)})` : '']
    .filter(Boolean).join(' ');

  // 3) Asunto: etiqueta de categoría + inicio del mensaje en una línea.
  const preview = clean(msg, SUBJECT_PREVIEW_CHARS);
  const subject = `${cat.tag} ${preview}${msg.length > SUBJECT_PREVIEW_CHARS ? '…' : ''}`;

  const text = [
    `Categoría: ${cat.nombre}`,
    `De: ${quien ? quien + ' — ' : ''}${user.email}`,
    '',
    'Mensaje:',
    msg,
    '',
    '— Contexto técnico —',
    `Versión: ${version}`,
    `Plataforma: ${platform}`,
    `Plan: ${plan}`,
    `User ID: ${user.id}`
  ].join('\n');

  // 4) Envío vía Resend (REST, sin SDK — mismo patrón que sign-document.js).
  //    En serverless el fetch SÍ se espera: responder antes congela la lambda.
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Emiti Soporte <soporte@emiti.app>',
        to: [FEEDBACK_TO],
        reply_to: [user.email],
        subject,
        text
      })
    });
    if (!resp.ok) throw new Error(`Resend ${resp.status}: ${await resp.text()}`);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[send-feedback] envío falló:', e.message);
    return res.status(502).json({ error: 'No se pudo enviar el mensaje' });
  }
};
