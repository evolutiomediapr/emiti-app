const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const ALLOWED_ORIGIN = 'https://emiti-app.vercel.app';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { invoiceId } = req.body;
  if (!invoiceId) return res.status(400).json({ error: 'invoiceId requerido' });

  // Fetch amount from DB — never trust the client-supplied amount
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: row, error: fetchErr } = await supabase
    .from('invoices')
    .select('data')
    .or(`id.eq.${invoiceId},slug.eq.${invoiceId}`)
    .single();

  if (fetchErr || !row) return res.status(404).json({ error: 'Factura no encontrada' });

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

  const label = inv.type === 'estimate' ? 'Cotización' : 'Factura';
  const description = `${label} ${inv.num || ''}`.trim();

  try {
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
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Pay invoice error:', err);
    res.status(500).json({ error: err.message });
  }
};
