const { createClient } = require('@supabase/supabase-js');
const { SignedDataVerifier, Environment } = require('@apple/app-store-server-library');
const fs = require('fs');
const path = require('path');

const ALLOWED_ORIGIN = 'https://emiti-app.vercel.app';
const BUNDLE_ID = 'app.emiti.app';
const PRODUCT_ID = 'app.emiti.app.pro.monthly';

// Apple Root CA certificates (DER, .cer) live in api/_apple_roots/.
// Download from https://www.apple.com/certificateauthority/ (AppleRootCA-G3 etc.).
let _roots = null;
function appleRoots() {
  if (_roots) return _roots;
  const dir = path.join(__dirname, '_apple_roots');
  try {
    _roots = fs.readdirSync(dir)
      .filter(f => /\.(cer|der)$/i.test(f))
      .map(f => fs.readFileSync(path.join(dir, f)));
  } catch { _roots = []; }
  return _roots;
}

// Verify the signed transaction against Apple. Apple signs both Sandbox and
// Production with chains rooted at the same Apple roots; the environment is in
// the payload, so we try Production first, then Sandbox.
async function verifyTransaction(jws) {
  const roots = appleRoots();
  if (!roots.length) throw new Error('Apple root certs no configurados (api/_apple_roots/)');
  let lastErr;
  for (const env of [Environment.PRODUCTION, Environment.SANDBOX]) {
    try {
      const appAppleId = env === Environment.PRODUCTION
        ? Number(process.env.APPLE_APP_APPLE_ID) : undefined;
      const verifier = new SignedDataVerifier(roots, true, env, BUNDLE_ID, appAppleId);
      return await verifier.verifyAndDecodeTransaction(jws);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('No verificable');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 1) Identify the Supabase user from the bearer token.
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: { user }, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Token inválido' });

  const { jws } = req.body || {};
  if (!jws) return res.status(400).json({ error: 'jws requerido' });

  // 2) Cryptographically verify the purchase with Apple's signature.
  let tx;
  try {
    tx = await verifyTransaction(jws);
  } catch (e) {
    console.error('[activate-iap] verificación falló:', e.message);
    return res.status(400).json({ error: 'Compra no verificable con Apple' });
  }

  // 3) Must be our subscription product.
  if (tx.productId !== PRODUCT_ID) {
    return res.status(400).json({ error: 'Producto inesperado: ' + tx.productId });
  }
  // Reject revoked transactions (refund / family-sharing removal).
  if (tx.revocationDate) {
    return res.status(409).json({ error: 'La compra fue revocada/reembolsada' });
  }

  const originalTransactionId = tx.originalTransactionId;
  const environment = tx.environment;

  // 4) Dedup: an Apple subscription maps to exactly one Emiti account.
  const { data: existing, error: selErr } = await admin
    .from('iap_transactions')
    .select('user_id')
    .eq('original_transaction_id', originalTransactionId)
    .maybeSingle();
  if (selErr) {
    console.error('[activate-iap] dedup select error:', selErr.message);
    return res.status(500).json({ error: 'Error de verificación de compra' });
  }
  if (existing && existing.user_id !== user.id) {
    return res.status(409).json({ error: 'Esta compra ya está asociada a otra cuenta' });
  }

  // 5) Record the transaction (idempotent) and grant Pro — both via service_role,
  //    the only role allowed to change profiles.plan (protect_profile_plan trigger).
  const { error: upErr } = await admin.from('iap_transactions').upsert({
    original_transaction_id: originalTransactionId,
    user_id: user.id,
    product_id: tx.productId,
    status: 'active',
    environment,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'original_transaction_id' });
  if (upErr) {
    console.error('[activate-iap] upsert error:', upErr.message);
    return res.status(500).json({ error: 'No se pudo registrar la compra' });
  }

  const { error: planErr } = await admin.from('profiles').update({ plan: 'pro' }).eq('id', user.id);
  if (planErr) {
    console.error('[activate-iap] plan update error:', planErr.message);
    return res.status(500).json({ error: 'No se pudo activar Pro' });
  }

  console.log(`[activate-iap] Pro activado — user ${user.id} orig ${originalTransactionId} (${environment})`);
  return res.json({ success: true, plan: 'pro' });
};

// Exported for offline tests.
module.exports.verifyTransaction = verifyTransaction;
module.exports._internals = { BUNDLE_ID, PRODUCT_ID };
