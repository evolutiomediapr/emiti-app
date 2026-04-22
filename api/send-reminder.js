const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { invoiceId } = req.body;
  if (!invoiceId) return res.status(400).json({ error: 'invoiceId requerido' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Verify the invoice exists before sending
  const { data: row, error } = await supabase
    .from('invoices')
    .select('id, data, client_phone, num')
    .or(`id.eq.${invoiceId},slug.eq.${invoiceId}`)
    .single();

  if (error || !row) return res.status(404).json({ error: 'Factura no encontrada' });

  let parsed;
  try { parsed = JSON.parse(row.data); } catch {
    return res.status(400).json({ error: 'Datos de factura inválidos' });
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

    // Mark reminder as sent
    await supabase
      .from('invoices')
      .update({ reminder_sent: true })
      .eq('id', row.id);

    res.json({ success: true, sid: msg.sid, to, num: inv.num });
  } catch (err) {
    console.error('[send-reminder] Twilio error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
