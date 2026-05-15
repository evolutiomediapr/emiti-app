const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');

const ALLOWED_ORIGIN = 'https://emiti-app.vercel.app';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify caller identity — never trust invoiceId without proving ownership
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const adminClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: { user }, error: authErr } = await adminClient.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Token inválido' });

  const { invoiceId } = req.body;
  if (!invoiceId) return res.status(400).json({ error: 'invoiceId requerido' });
  const { data: row, error } = await adminClient
    .from('invoices')
    .select('id, data, client_phone, num')
    .or(`id.eq.${invoiceId},slug.eq.${invoiceId}`)
    .single();

  if (error || !row) return res.status(404).json({ error: 'Factura no encontrada' });

  let parsed;
  try { parsed = JSON.parse(row.data); } catch {
    return res.status(400).json({ error: 'Datos de factura inválidos' });
  }

  // Reject if the invoice doesn't belong to the authenticated user
  if (parsed.inv?.userId !== user.id) {
    return res.status(403).json({ error: 'No autorizado para esta factura' });
  }

  const { inv, biz } = parsed;
  if (!inv || !biz) return res.status(400).json({ error: 'Estructura de datos incompleta' });

  const phone = inv.phone || row.client_phone;
  if (!phone) return res.status(400).json({ error: 'El cliente no tiene número de teléfono' });

  const to = '+1' + phone.replace(/\D/g, '');
  if (to.length !== 12) return res.status(400).json({ error: 'Número de teléfono inválido: ' + phone });

  const link = `https://emiti-app.vercel.app/invoice/${encodeURIComponent(inv.num)}`;
  const body = `Hola ${inv.client}, su factura ${inv.num} de $${parseFloat(inv.total).toFixed(2)} con ${biz.biz} está vencida. Ver: ${link}`;

  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const msg = await client.messages.create({
      body,
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
    });

    await adminClient
      .from('invoices')
      .update({ reminder_sent: true })
      .eq('id', row.id);

    res.json({ success: true, sid: msg.sid, to, num: inv.num });
  } catch (err) {
    console.error('[send-reminder] Twilio error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
