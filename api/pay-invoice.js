const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { invoiceId, amount, description, clientEmail } = req.body;
  if (!invoiceId || !amount) {
    return res.status(400).json({ error: 'invoiceId y amount requeridos' });
  }

  const amountCents = Math.round(parseFloat(amount) * 100);
  if (amountCents < 50) {
    return res.status(400).json({ error: 'El monto mínimo es $0.50' });
  }

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
      customer_email: clientEmail || undefined,
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
