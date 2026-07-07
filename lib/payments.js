// Lógica pura de pagos (depósito + balance), compartida por api/stripe-webhook.js
// (sumador) y por el harness de idempotencia. SIN dependencias externas ni side
// effects: es testeable con `node` directo, sin Stripe ni Supabase.
//
// DECISIÓN CONSCIENTE DE FASE 1 (documentada a propósito, como el tope del
// pass-through fee): el ledger de pagos vive dentro del JSON de la factura
// (inv.payments), NO en una tabla dedicada. Por eso NO es atómico a nivel BD:
// dos webhooks de pagos DISTINTOS que lleguen en el mismo milisegundo podrían
// pisarse (read-modify-write sobre el blob). Se acepta: el check de idempotencia
// por payment.id cubre el doble-disparo del MISMO pago (el caso real de Stripe),
// y depósito vs balance ocurren con días de diferencia, nunca concurrentes.
// Si algún día se necesita atomicidad estricta, migrar a una tabla `payments`
// con unique(payment_intent) (idempotencia a nivel BD, tipo sms_consents).

function invTotalCents(inv) {
  return Math.round(parseFloat(inv.total || 0) * 100);
}

function sumPaidCents(inv) {
  return (inv.payments || []).reduce((s, p) => s + (p.cents || 0), 0);
}

// status derivado del ledger — nunca se setea a mano.
function deriveStatus(inv) {
  const paid = sumPaidCents(inv);
  const total = invTotalCents(inv);
  if (paid <= 0) return 'pending';
  if (paid >= total) return 'paid';
  return 'partial';
}

// Aplica un pago al invoice (mutando inv). Idempotente por payment.id: si ya
// existe una entrada con ese id, es no-op (changed:false) — así el doble-disparo
// del webhook de Stripe no cuenta el mismo pago dos veces.
// payment: { id, method:'stripe'|'manual', kind:'deposit'|'balance'|'full', cents, at? }
function applyPayment(inv, payment) {
  if (!Array.isArray(inv.payments)) inv.payments = [];
  const id = payment.id;
  if (id && inv.payments.some(p => p.id === id)) {
    return { inv, changed: false }; // doble-disparo: ya contabilizado
  }
  const at = payment.at || new Date().toISOString();
  inv.payments.push({
    id,
    method: payment.method,
    kind: payment.kind,
    cents: payment.cents,
    at,
  });
  inv.amountPaidCents = sumPaidCents(inv);
  inv.status = deriveStatus(inv);
  if (inv.status === 'paid' && !inv.paidDate) inv.paidDate = at.split('T')[0];
  // paidVia legacy: compat con la lógica binaria existente. Cualquier pago Stripe
  // marca paidVia='stripe' (bloquea la reversión manual del total). El guard fino
  // por-entrada (no reducir bajo la porción Stripe) vive en la UI.
  if (payment.method === 'stripe') inv.paidVia = 'stripe';
  return { inv, changed: true };
}

// Reconciliación del pull nube->local (refreshPaymentStatuses). Solo INCORPORA
// las entradas method:'stripe' de la nube que el local aún no tiene (las escribe
// el webhook y el local no puede generarlas). Nunca toca entradas manuales ni
// reduce el monto pagado -> "más-pagado gana", "nunca degrada la porción Stripe".
function reconcilePayment(local, cloud) {
  const localIds = new Set((local.payments || []).map(p => p.id).filter(Boolean));
  const incoming = (cloud.payments || [])
    .filter(p => p.method === 'stripe' && p.id && !localIds.has(p.id));
  if (!incoming.length) return { inv: local, changed: false };
  local.payments = [...(local.payments || []), ...incoming];
  local.amountPaidCents = sumPaidCents(local);
  local.status = deriveStatus(local);
  if (!local.paidVia) local.paidVia = 'stripe';
  if (local.status === 'paid' && !local.paidDate) {
    local.paidDate = cloud.paidDate || new Date().toISOString().split('T')[0];
  }
  return { inv: local, changed: true };
}

module.exports = {
  invTotalCents,
  sumPaidCents,
  deriveStatus,
  applyPayment,
  reconcilePayment,
};
