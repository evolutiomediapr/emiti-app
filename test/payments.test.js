// Test de regresión para lib/payments.js — protege applyPayment() y
// reconcilePayment() (la lógica de pago más delicada del proyecto).
// Corre sin Stripe ni Supabase:  node test/payments.test.js
const assert = require('assert');
const { applyPayment, reconcilePayment, sumPaidCents, invTotalCents } = require('../lib/payments');

let n = 0;
const ok = (msg) => { console.log(`  ✓ ${msg}`); n++; };

console.log('Escenario A — depósito, doble-disparo, balance:');
const inv = { total: 1000, payments: [] };

// 1) Depósito $500 (pi_AAA)
let r = applyPayment(inv, { id: 'pi_AAA', method: 'stripe', kind: 'deposit', cents: 50000, at: '2026-07-07T10:00:00.000Z' });
assert.strictEqual(r.changed, true, 'depósito debe aplicar (changed:true)');
assert.strictEqual(sumPaidCents(inv), 50000, 'amountPaid=50000 tras depósito');
assert.strictEqual(inv.status, 'partial', 'status=partial tras depósito');
assert.strictEqual(inv.payments.length, 1, '1 entrada en el ledger');
assert.strictEqual(inv.paidVia, 'stripe', 'paidVia=stripe');
assert.strictEqual(inv.paidDate, undefined, 'sin paidDate (aún no pagada completa)');
ok('depósito $500 -> partial, 1 entrada');

// 2) DOBLE-DISPARO del mismo depósito (pi_AAA otra vez) -> no-op
r = applyPayment(inv, { id: 'pi_AAA', method: 'stripe', kind: 'deposit', cents: 50000, at: '2026-07-07T10:00:05.000Z' });
assert.strictEqual(r.changed, false, 'doble-disparo debe ser no-op (changed:false)');
assert.strictEqual(sumPaidCents(inv), 50000, 'amountPaid SIGUE 50000 (no se dobló)');
assert.strictEqual(inv.status, 'partial', 'status sigue partial');
assert.strictEqual(inv.payments.length, 1, 'SIGUE 1 entrada (idempotente)');
ok('doble-disparo del depósito ignorado (idempotente)');

// 3) Balance $500 (pi_BBB) -> paid
r = applyPayment(inv, { id: 'pi_BBB', method: 'stripe', kind: 'balance', cents: 50000, at: '2026-07-10T14:30:00.000Z' });
assert.strictEqual(r.changed, true, 'balance debe aplicar');
assert.strictEqual(sumPaidCents(inv), 100000, 'amountPaid=100000 tras balance');
assert.strictEqual(inv.status, 'paid', 'status=paid tras balance');
assert.strictEqual(inv.payments.length, 2, '2 entradas en el ledger');
assert.strictEqual(inv.paidDate, '2026-07-10', 'paidDate seteado al completar');
ok('balance $500 -> paid, 2 entradas, paidDate=2026-07-10');

// 4) DOBLE-DISPARO del balance (pi_BBB otra vez) -> no-op
r = applyPayment(inv, { id: 'pi_BBB', method: 'stripe', kind: 'balance', cents: 50000 });
assert.strictEqual(r.changed, false, 'doble-disparo del balance no-op');
assert.strictEqual(sumPaidCents(inv), 100000, 'amountPaid sigue 100000');
assert.strictEqual(inv.payments.length, 2, 'siguen 2 entradas');
ok('doble-disparo del balance ignorado (idempotente)');

console.log('\nEscenario B — reconciliador del pull (nube -> local):');
// B1) local con solo el depósito; nube con depósito + balance -> promueve a paid
{
  const local = { total: 1000, payments: [
    { id: 'pi_AAA', method: 'stripe', kind: 'deposit', cents: 50000, at: '2026-07-07T10:00:00.000Z' },
  ], amountPaidCents: 50000, status: 'partial', paidVia: 'stripe' };
  const cloud = { total: 1000, paidDate: '2026-07-10', payments: [
    { id: 'pi_AAA', method: 'stripe', kind: 'deposit', cents: 50000, at: '2026-07-07T10:00:00.000Z' },
    { id: 'pi_BBB', method: 'stripe', kind: 'balance', cents: 50000, at: '2026-07-10T14:30:00.000Z' },
  ] };
  const rr = reconcilePayment(local, cloud);
  assert.strictEqual(rr.changed, true, 'debe incorporar el balance de la nube');
  assert.strictEqual(sumPaidCents(local), 100000, 'local ahora 100000');
  assert.strictEqual(local.status, 'paid', 'local ahora paid');
  assert.strictEqual(local.payments.length, 2, 'local ahora 2 entradas');
  ok('nube con más pagado -> local promueve a paid');
}

// B2) local ya paid (dep+balance); nube "atrás" (solo depósito) -> NO degrada
{
  const local = { total: 1000, payments: [
    { id: 'pi_AAA', method: 'stripe', kind: 'deposit', cents: 50000 },
    { id: 'pi_BBB', method: 'stripe', kind: 'balance', cents: 50000 },
  ], amountPaidCents: 100000, status: 'paid', paidVia: 'stripe', paidDate: '2026-07-10' };
  const cloud = { total: 1000, payments: [
    { id: 'pi_AAA', method: 'stripe', kind: 'deposit', cents: 50000 },
  ] };
  const rr = reconcilePayment(local, cloud);
  assert.strictEqual(rr.changed, false, 'no debe cambiar (nube tiene menos)');
  assert.strictEqual(sumPaidCents(local), 100000, 'local SIGUE 100000 (no degrada)');
  assert.strictEqual(local.status, 'paid', 'local sigue paid');
  assert.strictEqual(local.payments.length, 2, 'siguen 2 entradas');
  ok('nube atrasada -> local NO degrada la porción Stripe');
}

// B3) local con pago manual; la nube trae un stripe nuevo -> suma stripe, conserva manual
{
  const local = { total: 1000, payments: [
    { id: 'man_1', method: 'manual', kind: 'deposit', cents: 20000 },
  ], amountPaidCents: 20000, status: 'partial' };
  const cloud = { total: 1000, payments: [
    { id: 'man_1', method: 'manual', kind: 'deposit', cents: 20000 },
    { id: 'pi_CCC', method: 'stripe', kind: 'balance', cents: 80000, at: '2026-07-11T09:00:00.000Z' },
  ] };
  const rr = reconcilePayment(local, cloud);
  assert.strictEqual(rr.changed, true, 'debe incorporar el stripe de la nube');
  assert.strictEqual(sumPaidCents(local), 100000, 'local ahora 100000 (20k manual + 80k stripe)');
  assert.strictEqual(local.status, 'paid', 'local paid');
  assert.strictEqual(local.payments.filter(p => p.method === 'manual').length, 1, 'conserva 1 manual (sin duplicar)');
  ok('conserva pago manual y suma el stripe nuevo de la nube');
}

console.log('\nEscenario C — balance para recordatorios (Fase 2 depósitos):');
// El cron y send-reminder muestran balanceCents = invTotalCents - sumPaidCents
// cuando la factura es 'partial'. Se valida la expresión exacta que usan.
{
  const inv = { total: 1000, payments: [{ id:'pi_X', method:'stripe', kind:'deposit', cents:40000 }] };
  const balanceCents = invTotalCents(inv) - sumPaidCents(inv);
  assert.strictEqual(balanceCents, 60000, 'balance = 100000 - 40000 = 60000');
  assert.strictEqual((balanceCents/100).toFixed(2), '600.00', 'balance en dólares = 600.00');
  ok('factura $1000 con depósito $400 -> recordatorio muestra balance $600.00');
}
// Factura pending (sin pagos): balance = total (mensaje normal).
{
  const inv = { total: 250, payments: [] };
  const balanceCents = invTotalCents(inv) - sumPaidCents(inv);
  assert.strictEqual((balanceCents/100).toFixed(2), '250.00', 'pending -> total $250.00');
  ok('factura pending $250 -> recordatorio muestra total $250.00');
}

console.log(`\nTODOS LOS ASSERTS PASARON (${n} checks).`);
