const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Deshabilitar body parser — Stripe necesita el raw body para verificar firma
export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  const subscription = event.data.object;

  try {
    switch (event.type) {
      // Suscripción activada o actualizada
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        if (subscription.status === 'active') {
          await supabase
            .from('profiles')
            .update({
              plan: 'pro',
              stripe_subscription_id: subscription.id,
            })
            .eq('stripe_customer_id', subscription.customer);
          console.log(`Plan Pro activado para customer: ${subscription.customer}`);
        } else if (['canceled', 'unpaid', 'past_due'].includes(subscription.status)) {
          await supabase
            .from('profiles')
            .update({ plan: 'free', stripe_subscription_id: null })
            .eq('stripe_customer_id', subscription.customer);
        }
        break;

      // Suscripción cancelada
      case 'customer.subscription.deleted':
        await supabase
          .from('profiles')
          .update({ plan: 'free', stripe_subscription_id: null })
          .eq('stripe_customer_id', subscription.customer);
        console.log(`Plan degradado a Free para customer: ${subscription.customer}`);
        break;
    }
  } catch (err) {
    console.error('DB update error:', err);
    return res.status(500).json({ error: 'Error actualizando base de datos' });
  }

  res.json({ received: true });
};
