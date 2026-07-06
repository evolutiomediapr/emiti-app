const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const ALLOWED_ORIGIN = 'https://emiti-app.vercel.app';

// Configuración "Standard-equivalente" del modelo unificado de cuentas:
// Stripe le factura sus fees al usuario, asume las pérdidas por disputas y
// le da dashboard completo. La plataforma no paga nada por cuenta conectada
// y cobra application_fee_amount en los direct charges (C2).
const CONTROLLER = {
  fees: { payer: 'account' },
  losses: { payments: 'stripe' },
  stripe_dashboard: { type: 'full' },
};

// Países habilitados para crear la cuenta conectada. PR opera bajo US.
// El front aún no envía country (default US); el parámetro queda validado
// server-side para cuando la UI exponga el selector.
const ALLOWED_COUNTRIES = ['US', 'MX', 'ES'];

function mapAccountStatus(acct) {
  if (acct.charges_enabled && acct.details_submitted) return 'active';
  if (acct.requirements?.disabled_reason) return 'restricted';
  return 'pending';
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // userId must come from the verified JWT — never from the request body
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Token inválido' });

  const { action = 'link', country = 'US' } = req.body || {};

  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('stripe_connect_id, stripe_connect_status')
      .eq('id', user.id)
      .single();

    if (action === 'status') {
      if (!profile?.stripe_connect_id) return res.json({ status: null });
      const acct = await stripe.accounts.retrieve(profile.stripe_connect_id);
      const status = mapAccountStatus(acct);
      if (status !== profile.stripe_connect_status) {
        await supabase.from('profiles')
          .update({ stripe_connect_status: status })
          .eq('id', user.id);
      }
      return res.json({ status });
    }

    // action 'link': crea la cuenta si no existe y devuelve el Account Link
    // de onboarding hosteado. Reintentable: si el usuario abandonó a medias,
    // se genera un link nuevo sobre la misma cuenta.
    let acctId = profile?.stripe_connect_id;
    if (!acctId) {
      if (!ALLOWED_COUNTRIES.includes(country)) {
        return res.status(400).json({ error: 'País no soportado para Stripe' });
      }
      const acct = await stripe.accounts.create({
        controller: CONTROLLER,
        country,
        email: user.email,
        metadata: { supabase_uid: user.id },
      });
      acctId = acct.id;
      await supabase.from('profiles')
        .update({ stripe_connect_id: acctId, stripe_connect_status: 'pending' })
        .eq('id', user.id);
    }

    const link = await stripe.accountLinks.create({
      account: acctId,
      type: 'account_onboarding',
      refresh_url: `${process.env.APP_URL}/?stripe_connect=refresh`,
      return_url: `${process.env.APP_URL}/?stripe_connect=return`,
    });

    res.json({ url: link.url });
  } catch (err) {
    console.error('Connect Stripe error:', err);
    res.status(500).json({ error: err.message });
  }
};
