const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const ALLOWED_ORIGIN = 'https://emiti-app.vercel.app';

// Fee de plataforma por plan, en basis points (mismo esquema que Tap to Pay).
// Se lee SIEMPRE de profiles server-side — nunca del cliente.
const FEE_BPS = { free: 100, pro: 50 }; // 1% Free / 0.5% Pro

// Comisión estándar de Stripe en EE.UU. para direct charges (2.9% + $0.30).
// Es un ESTIMADO: tarjetas internacionales/Amex cobran más y en esos casos el
// negocio neto queda unos centavos bajo T. Inherente a cualquier pass-through.
const STRIPE_PCT = 0.029;
const STRIPE_FIXED_CENTS = 30;

// Tope del "Cargo por procesamiento" que se le muestra/cobra al cliente.
// 4.5% queda por ENCIMA del costo real de ambos planes (Free ~4.02%, Pro ~3.50%),
// así que solo muerde en facturas muy pequeñas (<~$64 Free / <~$31 Pro), donde el
// $0.30 fijo dispara el %. Ver computePassThrough para el manejo del tope.
const PASS_FEE_CAP = 0.045;

// Calcula el "Cargo por procesamiento" cuando el negocio activó pass_processing_fee.
// amountCents = total de la factura (T); feeCents = application_fee de plataforma (A = bps·T).
// Gross-up: el % de Stripe aplica sobre el TOTAL cobrado (C), no sobre T, así que se
// despeja C para que el negocio netee T exactamente:  C = (T + fijo + A) / (1 - pct).
function computePassThrough(amountCents, feeCents) {
  const cUncapped = Math.ceil((amountCents + STRIPE_FIXED_CENTS + feeCents) / (1 - STRIPE_PCT));
  const processingTrue = cUncapped - amountCents;         // cargo que netea T al negocio
  const capCents = Math.floor(PASS_FEE_CAP * amountCents); // techo del 4.5%
  const processingShown = Math.min(processingTrue, capCents);
  // DECISIÓN DE NEGOCIO CONSCIENTE (no bug): cuando processingShown < processingTrue
  // (facturas pequeñas), el cliente NUNCA paga más del tope; el negocio ABSORBE la
  // diferencia y recibe un poco menos de T. Protege al cliente del % alto que causa
  // el $0.30 fijo en tickets chicos. application_fee (A) no cambia — la plataforma
  // cobra igual; el que cede es el negocio, por elección.
  return { processingShown, cFinal: amountCents + processingShown };
}

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
    .select('id, data, user_id')
    .eq(lookupCol, invoiceId)
    .single();

  if (fetchErr || !row) return res.status(404).json({ error: 'Factura no encontrada' });

  // El cargo va DIRECTO a la cuenta conectada del dueño de la factura.
  // Docs pre-v1.5 sin user_id backfilleado no ofrecen tarjeta.
  let profile = null;
  if (row.user_id) {
    const { data } = await supabase
      .from('profiles')
      .select('plan, stripe_connect_id, stripe_connect_status, pass_processing_fee')
      .eq('id', row.user_id)
      .single();
    profile = data;
  }
  const cardAvailable = !!(profile && profile.stripe_connect_id && profile.stripe_connect_status === 'active');

  // El visor consulta 'methods' al renderizar para decidir si muestra el
  // botón de tarjeta (POST a propósito: los GET cacheados rompieron Safari).
  // Si el negocio activó el pass-through, se devuelve también el estimado del
  // cargo para avisarle al cliente ANTES de que haga clic (transparencia).
  if (action === 'methods') {
    let passThrough = !!(profile && profile.pass_processing_fee);
    let feeEstimate = 0;
    if (cardAvailable && passThrough) {
      try {
        const inv0 = JSON.parse(row.data).inv;
        const a = Math.round(parseFloat(inv0.total) * 100);
        if (!isNaN(a) && a >= 50) {
          const bps0 = FEE_BPS[profile.plan] ?? FEE_BPS.free;
          const fee0 = Math.round((a * bps0) / 10000);
          feeEstimate = computePassThrough(a, fee0).processingShown / 100; // en dólares
        }
      } catch { /* estimado best-effort: si el parse falla, no se muestra aviso */ }
    }
    // Sin cargo estimado (>0) no hay nada que avisar; el visor no muestra la nota.
    if (feeEstimate <= 0) passThrough = false;
    return res.json({ card: cardAvailable, passThrough, feeEstimate });
  }

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

  // Pass-through: si el negocio lo activó, se añade un segundo line item con el
  // "Cargo por procesamiento (tarjeta)" para que el cliente reciba T completo.
  // Dos line items (factura + cargo) => el Checkout de Stripe muestra el desglose.
  const passOn = !!profile.pass_processing_fee;
  const { processingShown } = passOn
    ? computePassThrough(amountCents, feeCents)
    : { processingShown: 0 };

  const line_items = [{
    price_data: {
      currency: 'usd',
      product_data: { name: description || 'Factura' },
      unit_amount: amountCents,
    },
    quantity: 1,
  }];
  if (processingShown > 0) {
    line_items.push({
      price_data: {
        currency: 'usd',
        product_data: { name: 'Cargo por procesamiento (tarjeta)' },
        unit_amount: processingShown,
      },
      quantity: 1,
    });
  }

  try {
    // Direct charge sobre la cuenta conectada: el usuario paga los fees de
    // Stripe como cuenta propia y application_fee_amount llega neto a la
    // plataforma. checkout.session.completed de este cargo entra por el
    // webhook endpoint de Connect (mismo handler, secret distinto).
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items,
      mode: 'payment',
      customer_email: inv.email || undefined,
      success_url: `${process.env.APP_URL}/invoice/${invoiceId}?paid=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL}/invoice/${invoiceId}`,
      // Siempre el id numérico de la fila: el visor manda el slug, y el
      // webhook resuelve la factura por este metadata.
      metadata: { supabase_invoice_id: String(row.id) },
      ...(feeCents > 0 ? { payment_intent_data: { application_fee_amount: feeCents } } : {}),
    }, { stripeAccount: profile.stripe_connect_id });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Pay invoice error:', err);
    res.status(500).json({ error: err.message });
  }
};
