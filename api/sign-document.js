const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { invTotalCents } = require('../lib/payments');

const ALLOWED_ORIGIN = 'https://emiti-app.vercel.app';

// Techo del PNG de la firma (data-URL base64). Una firma real pesa 5-20KB;
// 300K chars (~225KB binario) corta payloads basura sin molestar a nadie.
const MAX_SIG_CHARS = 300000;
const MAX_NAME_CHARS = 120;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (req.method === 'GET') return getStatus(req, res, supabase);
  if (req.method === 'POST') return signDocument(req, res, supabase);
  return res.status(405).json({ error: 'Method not allowed' });
};

// Resuelve la fila de invoices por slug o id numérico (mismo criterio que
// pay-invoice.js: id es bigint y un .or() con slug no numérico revienta el
// cast en PostgREST). maybeSingle: un slug inexistente no es un error 500.
async function fetchInvoice(supabase, invoiceId, columns) {
  const lookupCol = /^\d+$/.test(String(invoiceId)) ? 'id' : 'slug';
  return supabase.from('invoices').select(columns)
    .eq(lookupCol, invoiceId)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
}

// GET ?invoiceId= -> { signed, signedAt }. Deliberadamente mínimo: NI nombre
// NI png. La firma es dato sensible y RLS no da SELECT a anon: esta respuesta
// es lo ÚNICO que el visor público puede saber de una firma.
async function getStatus(req, res, supabase) {
  const invoiceId = req.query.invoiceId;
  if (!invoiceId) return res.status(400).json({ error: 'invoiceId requerido' });
  const { data: row, error } = await fetchInvoice(supabase, invoiceId, 'id');
  if (error || !row) return res.status(404).json({ error: 'Documento no encontrado' });
  const { data: sig, error: sigErr } = await supabase
    .from('document_signatures')
    .select('signed_at')
    .eq('invoice_id', row.id)
    .maybeSingle();
  if (sigErr) return res.status(500).json({ error: 'No se pudo consultar el estado' });
  return res.status(200).json({ signed: !!sig, signedAt: sig ? sig.signed_at : null });
}

async function signDocument(req, res, supabase) {
  const { invoiceId, signerName, signaturePng, viewedAt } = req.body || {};

  // Validaciones baratas antes de tocar la BD.
  if (!invoiceId) return res.status(400).json({ error: 'invoiceId requerido' });
  const name = String(signerName || '').trim();
  if (!name || name.length > MAX_NAME_CHARS) return res.status(400).json({ error: 'Nombre inválido' });
  if (typeof signaturePng !== 'string'
      || !signaturePng.startsWith('data:image/png;base64,')
      || signaturePng.length > MAX_SIG_CHARS) {
    return res.status(400).json({ error: 'Firma inválida' });
  }
  // viewedAt es AFIRMADO por el visor (cuándo cargó el doc); se registra tal
  // cual como evidencia complementaria. signed_at, en cambio, es del server.
  const viewed = viewedAt && !isNaN(Date.parse(viewedAt)) ? new Date(viewedAt).toISOString() : null;

  const { data: row, error: fetchErr } =
    await fetchInvoice(supabase, invoiceId, 'id, slug, num, type, data, user_id');
  if (fetchErr || !row) return res.status(404).json({ error: 'Documento no encontrado' });

  // Gates server-side contra la BD: NUNCA se confía en lo que diga el visor.
  if (row.type !== 'estimate') return res.status(422).json({ error: 'Solo las cotizaciones se pueden firmar' });
  if (!row.user_id) return res.status(422).json({ error: 'Documento no habilitado para firma' });

  let inv;
  try { inv = JSON.parse(row.data).inv; } catch { inv = null; }
  if (!inv) return res.status(422).json({ error: 'Documento ilegible' });
  // Cotización vencida no se puede aceptar (validUntil es fecha YYYY-MM-DD).
  if (inv.validUntil && new Date().toISOString().split('T')[0] > inv.validUntil) {
    return res.status(410).json({ error: 'La cotización venció' });
  }

  // Evidencia: snapshot de EXACTAMENTE el JSON en la BD al momento de firmar
  // (inmune al overwrite del sync wholesale) + sha256 que prueba integridad.
  const docHash = crypto.createHash('sha256').update(row.data).digest('hex');
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null;
  const userAgent = req.headers['user-agent'] || null;

  // INSERT, jamás upsert: one_signature_per_document es el enforcement real
  // de una-firma-por-documento. Duplicado -> 23505 -> 409 (primera firma gana).
  const { data: sig, error: insErr } = await supabase
    .from('document_signatures')
    .insert({
      invoice_id: row.id,
      owner_user_id: row.user_id,
      doc_type: 'estimate',
      signer_name: name,
      signature_png: signaturePng,
      doc_hash: docHash,
      doc_snapshot: row.data,
      viewed_at: viewed,
      ip,
      user_agent: userAgent
    })
    .select('signed_at')
    .single();

  if (insErr) {
    if (insErr.code === '23505') return res.status(409).json({ error: 'already_signed' });
    console.error('[sign-document] insert:', insErr.message);
    return res.status(500).json({ error: 'No se pudo guardar la firma' });
  }

  // Notificación al dueño. "Fire-and-forget con catch": el fetch SÍ se espera
  // (en serverless, responder congela la lambda y un envío no esperado muere a
  // mitad), pero un fallo de Resend NUNCA deshace la firma ya insertada — el
  // dueño la verá igual por el pull de la app.
  try {
    await notifyOwner(supabase, row, inv, name, sig.signed_at);
  } catch (e) {
    console.error('[sign-document] email:', e.message);
  }

  return res.status(200).json({ ok: true, signedAt: sig.signed_at });
}

// Email al dueño vía Resend (REST, sin SDK). Solo el link, sin firma embebida:
// la firma vive en la tabla y el dueño la ve en el documento o en su app.
// Copy en español neutro internacional (tuteo, sin regionalismos).
async function notifyOwner(supabase, row, inv, signerName, signedAt) {
  const { data: profile } = await supabase
    .from('profiles').select('email').eq('id', row.user_id).single();
  if (!profile || !profile.email) return;

  const total = (invTotalCents(inv) / 100)
    .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fecha = new Date(signedAt).toLocaleDateString('es', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Puerto_Rico'
  });
  const link = `https://emiti-app.vercel.app/invoice/${encodeURIComponent(row.slug || row.num)}`;
  const num = row.num || '';

  const text = [
    'Hola:',
    '',
    `Tu cotización ${num} fue aceptada y firmada.`,
    '',
    `Firmada por: ${signerName}`,
    `Fecha: ${fecha}`,
    `Total: $${total}`,
    '',
    'Puedes ver el documento aquí:',
    link,
    '',
    'La firma también está disponible en tu aplicación de Emiti.',
    '',
    '— Emiti',
    'Este es un mensaje automático. No es necesario responder.'
  ].join('\n');

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Emiti <notificaciones@emiti.app>',
      to: [profile.email],
      subject: `${signerName} aceptó tu cotización ${num}`.trim(),
      text
    })
  });
  if (!resp.ok) throw new Error(`Resend ${resp.status}: ${await resp.text()}`);
}
