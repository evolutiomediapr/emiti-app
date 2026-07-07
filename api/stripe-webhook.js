const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const handler = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  // Dos endpoints de Stripe apuntan a esta URL con secrets distintos:
  // el de cuenta (suscripciones Pro) y el de Connect (account.updated de
  // cuentas conectadas). Se intenta verificar con ambos.
  const secrets = [
    process.env.STRIPE_WEBHOOK_SECRET,
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET,
  ].filter(Boolean);

  let event = null;
  let lastErr = null;
  for (const secret of secrets) {
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, secret);
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!event) {
    console.error('Webhook signature error:', lastErr?.message);
    return res.status(400).json({ error: `Webhook error: ${lastErr?.message}` });
  }

  const subscription = event.data.object;

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const invoiceId = session.metadata?.supabase_invoice_id;
        if (invoiceId && session.payment_status === 'paid') {
          // id es bigint: sesiones creadas antes del fix de metadata traen el
          // slug aquí, y un .eq('id', slug) rompe el cast y pierde el pago.
          const lookupCol = /^\d+$/.test(String(invoiceId)) ? 'id' : 'slug';
          const { data: row, error: fetchErr } = await supabase
            .from('invoices')
            .select('id, data')
            .eq(lookupCol, invoiceId)
            .single();

          if (fetchErr) {
            console.error('Error fetching invoice:', fetchErr.message);
            break;
          }

          if (row?.data) {
            let parsed;
            try { parsed = JSON.parse(row.data); } catch { break; }
            parsed.inv.status = 'paid';
            if (!parsed.inv.paidDate) parsed.inv.paidDate = new Date().toISOString().split('T')[0];
            const { error: updateErr } = await supabase
              .from('invoices')
              .update({ data: JSON.stringify(parsed) })
              .eq('id', row.id);
            if (updateErr) console.error('Error updating invoice status:', updateErr.message);
            else console.log(`Factura ${row.id} marcada como pagada`);
          }
        }
        break;
      }

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

      case 'customer.subscription.deleted':
        await supabase
          .from('profiles')
          .update({ plan: 'free', stripe_subscription_id: null })
          .eq('stripe_customer_id', subscription.customer);
        console.log(`Plan degradado a Free para customer: ${subscription.customer}`);
        break;

      // Connect: estado de onboarding de la cuenta conectada del usuario.
      // Fuente de verdad del badge Conectado/Pendiente en Métodos de Pago.
      case 'account.updated': {
        const acct = event.data.object;
        const status = (acct.charges_enabled && acct.details_submitted)
          ? 'active'
          : (acct.requirements?.disabled_reason ? 'restricted' : 'pending');
        const { error: connErr } = await supabase
          .from('profiles')
          .update({ stripe_connect_status: status })
          .eq('stripe_connect_id', acct.id);
        if (connErr) console.error('Error actualizando connect status:', connErr.message);
        else console.log(`Connect ${acct.id} -> ${status}`);
        break;
      }
    }
  } catch (err) {
    console.error('DB update error:', err);
    return res.status(500).json({ error: 'Error actualizando base de datos' });
  }

  res.json({ received: true });
};

// CJS-compatible config export — bodyParser must be disabled for Stripe signature verification
handler.config = { api: { bodyParser: false } };
module.exports = handler;
