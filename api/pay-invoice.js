const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const ALLOWED_ORIGIN = 'https://emiti-app.vercel.app';

// Fee de plataforma por plan, en basis points (mismo esquema que Tap to Pay).
// Se lee SIEMPRE de profiles server-side — nunca del cliente.
const FEE_BPS = { free: 100, pro: 50 }; // 1% Free / 0.5% Pro

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { invoiceId, action = 'checkout' } = req.body;
  if (!invoiceId) return res.status(400).json({ error: 'invoiceId requerido' });

  // Fetch amount from DB — never trust the client-supplied amount
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  // id es bigint: un .or() con slug no numérico revienta el cast en PostgREST
  // y la query entera falla como "no encontrada". El visor público siempre
  // manda el slug, así que se decide la columna según la forma del identificador.
  const lookupCol = /^\d+$/.test(String(invoiceId)) ? 'id' : 'slug';
  const { data: row, error: fetchErr } = await supabase
    .from('invoices')
    .select('data, user_id')
    .eq(lookupCol, invoiceId)
    .single();

  if (fetchErr || !row) return res.status(404).json({ error: 'Factura no encontrada' });

  // El cargo va DIRECTO a la cuenta conectada del dueño de la factura.
  // Docs pre-v1.5 sin user_id backfilleado no ofrecen tarjeta.
  let profile = null;
  if (row.user_id) {
    const { data } = await supabase
      .from('profiles')
      .select('plan, stripe_connect_id, stripe_connect_status')
      .eq('id', row.user_id)
      .single();
    profile = data;
  }
  const cardAvailable = !!(profile && profile.stripe_connect_id && profile.stripe_connect_status === 'active');

  // El visor consulta 'methods' al renderizar para decidir si muestra el
  // botón de tarjeta (POST a propósito: los GET cacheados rompieron Safari).
  if (action === 'methods') return res.json({ card: cardAvailable });

  if (!cardAvailable) {
    return res.status(409).json({ error: 'El pago con tarjeta no está disponible para este documento' });
  }

  let parsed;
  try { parsed = JSON.parse(row.data); } catch {
    return res.status(400).json({ error: 'Datos de factura inválidos' });
  }

  const { inv } = parsed;
  if (!inv?.total) return res.status(400).json({ error: 'Factura sin monto' });

  const amountCents = Math.round(parseFloat(inv.total) * 100);
  if (isNaN(amountCents) || amountCents < 50) {
    return res.status(400).json({ error: 'Monto inválido o menor al mínimo de $0.50' });
  }

  const bps = FEE_BPS[profile.plan] ?? FEE_BPS.free;
  const feeCents = Math.round((amountCents * bps) / 10000);

  const label = inv.type === 'estimate' ? 'Cotización' : 'Factura';
  const description = `${label} ${inv.num || ''}`.trim();

  try {
    // Direct charge sobre la cuenta conectada: el usuario paga los fees de
    // Stripe como cuenta propia y application_fee_amount llega neto a la
    // plataforma. checkout.session.completed de este cargo entra por el
    // webhook endpoint de Connect (mismo handler, secret distinto).
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: description || 'Factura' },
          unit_amount: amountCents,
        },
        quantity: 1,
      }],
      mode: 'payment',
      customer_email: inv.email || undefined,
      success_url: `${process.env.APP_URL}/invoice/${invoiceId}?paid=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL}/invoice/${invoiceId}`,
      metadata: { supabase_invoice_id: String(invoiceId) },
      ...(feeCents > 0 ? { payment_intent_data: { application_fee_amount: feeCents } } : {}),
    }, { stripeAccount: profile.stripe_connect_id });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Pay invoice error:', err);
    res.status(500).json({ error: err.message });
  }
};
