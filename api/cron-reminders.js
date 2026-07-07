const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');

// Runs daily at 9am AST (13:00 UTC) via Vercel Cron.
// Queries Supabase for overdue unpaid invoices and sends SMS via Twilio.
module.exports = async (req, res) => {
  // Vercel cron passes Authorization: Bearer <CRON_SECRET>
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
  const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  // Fetch all invoices that haven't been reminded yet
  const { data: rows, error } = await supabase
    .from('invoices')
    .select('id, data, client_phone, num')
    .eq('type', 'invoice')
    .or('reminder_sent.is.null,reminder_sent.eq.false');

  if (error) {
    console.error('[cron-reminders] Supabase query error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  // Load opted-out phone numbers (set by api/sms-webhook.js when a client texts STOP).
  const optedOut = new Set();
  const { data: optouts } = await supabase
    .from('sms_optouts')
    .select('phone')
    .eq('opted_out', true);
  for (const o of optouts || []) optedOut.add(o.phone);

  // Consentimiento explícito y auditable (sms_consents). A2P 10DLC exige opt-in
  // verificable: solo se envía a teléfonos con una fila de consentimiento que el
  // negocio registró (modelo on-behalf). Es el segundo filtro del triple gate,
  // junto a inv.smsConsent (intención por-factura) y sms_optouts (STOP del cliente).
  const consented = new Set();
  const { data: consents } = await supabase
    .from('sms_consents')
    .select('phone');
  for (const c of consents || []) consented.add(c.phone);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const sent = [];
  const skipped = [];
  const failed = [];

  for (const row of rows) {
    let parsed;
    try { parsed = JSON.parse(row.data); } catch { skipped.push({ id: row.id, reason: 'JSON inválido' }); continue; }

    const { inv, biz } = parsed;

    // Skip estimates, paid, or missing data
    if (!inv || !biz || inv.type !== 'invoice' || inv.status === 'paid') {
      skipped.push({ num: row.num, reason: 'no aplica' });
      continue;
    }

    // Determine overdue: invoice date + remind_days (default 7)
    const remindDays = parseInt(inv.remindDays || '7', 10);
    const invoiceDate = new Date(inv.date + 'T12:00:00');
    const dueDate = new Date(invoiceDate.getTime() + remindDays * 24 * 60 * 60 * 1000);

    if (dueDate >= today) {
      skipped.push({ num: inv.num, reason: 'aún no vencida', dueDate: dueDate.toISOString().slice(0, 10) });
      continue;
    }

    // A2P 10DLC: only send when the business confirmed the client's SMS consent.
    if (!inv.smsConsent) {
      skipped.push({ num: inv.num, reason: 'sin consentimiento SMS' });
      continue;
    }

    const phone = inv.phone || row.client_phone;
    if (!phone) {
      skipped.push({ num: inv.num, reason: 'sin teléfono' });
      continue;
    }

    const digits = phone.replace(/\D/g, '');

    // A2P: exigir consentimiento registrado y auditable (sms_consents), no solo el
    // flag inv.smsConsent del JSON. Sin fila de consentimiento no se envía.
    if (!consented.has(digits.slice(-10))) {
      skipped.push({ num: inv.num, reason: 'sin consentimiento registrado (sms_consents)' });
      continue;
    }

    // Respect opt-out: client texted STOP (recorded by api/sms-webhook.js).
    if (optedOut.has(digits.slice(-10))) {
      skipped.push({ num: inv.num, reason: 'cliente canceló (STOP)' });
      continue;
    }

    const to = digits.length === 10 ? '+1' + digits : '+' + digits;

    const link = `https://emiti-app.vercel.app/invoice/${encodeURIComponent(inv.num)}`;
    // LIMITACIÓN CONSCIENTE FASE 1 (no es bug): el monto es inv.total, no el
    // balance pendiente. Con depósitos, una factura 'partial' que reciba
    // recordatorio mostraría el total completo. Aceptable porque SMS aún no está
    // activo (A2P pendiente). Fase 2: usar el balance (total - amountPaidCents).
    const body = `Hola ${inv.client}, su factura ${inv.num} de $${parseFloat(inv.total).toFixed(2)} con ${biz.biz} está vencida. Ver: ${link}\n\nResponde STOP para cancelar. Responde HELP para ayuda. Pueden aplicar tarifas de mensajes.`;

    try {
      const msg = await twilioClient.messages.create({
        body,
        from: process.env.TWILIO_PHONE_NUMBER,
        to,
      });

      await supabase
        .from('invoices')
        .update({ reminder_sent: true })
        .eq('id', row.id);

      sent.push({ num: inv.num, to, sid: msg.sid });
      console.log(`[cron-reminders] SMS enviado — ${inv.num} → ${to}`);
    } catch (err) {
      console.error(`[cron-reminders] Error enviando a ${to}:`, err.message);
      failed.push({ num: inv.num, to, error: err.message });
    }
  }

  const summary = { sent: sent.length, skipped: skipped.length, failed: failed.length, sent, skipped, failed };
  console.log('[cron-reminders] Resumen:', JSON.stringify(summary));
  res.json(summary);
};
