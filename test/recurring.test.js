// Test de regresión para lib/recurring.js — protege la lógica de fecha, catch-up
// e idempotencia (guard de período) de las facturas recurrentes. Corre sin red:
//   node test/recurring.test.js
const assert = require('assert');
const { computeRecurring, monthlyAfterMonth } = require('../lib/recurring.js');

let n = 0;
const ok = (msg) => { console.log(`  ✓ ${msg}`); n++; };

const TODAY = '2026-07-15';

console.log('recurring — computeRecurring (hoy = 2026-07-15):');

// 1) Vencida hace 1 día -> genera; período de hoy; next_run salta al mes siguiente.
{
  const r = computeRecurring({ active: true, start_date: '2026-06-14', next_run_date: '2026-07-14', last_generated_period: '2026-06' }, TODAY);
  assert.strictEqual(r.shouldGenerate, true, 'vencida -> genera');
  assert.strictEqual(r.period, '2026-07', 'período = mes de hoy');
  assert.strictEqual(r.newNextRunDate, '2026-08-14', 'next_run -> 2026-08-14 (mes siguiente, día 14)');
  ok('vencida 1 día -> genera 1, next_run 2026-08-14');
}

// 2) 3 meses atrasada -> genera UNA sola (período actual), salta a futuro, NO acumula.
{
  const r = computeRecurring({ active: true, start_date: '2026-04-01', next_run_date: '2026-04-01', last_generated_period: '2026-03' }, TODAY);
  assert.strictEqual(r.shouldGenerate, true, 'atrasada -> genera');
  assert.strictEqual(r.period, '2026-07', 'período = mes ACTUAL (no abril/mayo/junio)');
  assert.strictEqual(r.newNextRunDate, '2026-08-01', 'salta directo a 2026-08-01 (un solo brinco)');
  ok('3 meses atrasada -> genera 1 (jul), salta a 2026-08-01, no acumula');
}

// 3) Fin de mes: 31 -> febrero se clampa a 28 (2026 no bisiesto).
{
  const r = computeRecurring({ active: true, start_date: '2026-01-31', next_run_date: '2026-01-31' }, '2026-01-31');
  assert.strictEqual(r.shouldGenerate, true, 'fin de mes -> genera');
  assert.strictEqual(r.newNextRunDate, '2026-02-28', 'día 31 en febrero -> 2026-02-28');
  ok('fin de mes 31 -> next_run 2026-02-28 (clamp)');
}
// 3b) Bisiesto: 31 -> febrero 2028 se clampa a 29.
{
  assert.strictEqual(monthlyAfterMonth('2028-01-31', 31), '2028-02-29', '2028 bisiesto -> 29');
  ok('fin de mes 31 en año bisiesto -> 2028-02-29');
}

// 4) last_generated_period ya es este mes -> NO genera (idempotencia).
{
  const r = computeRecurring({ active: true, start_date: '2026-07-01', next_run_date: '2026-07-01', last_generated_period: '2026-07' }, TODAY);
  assert.strictEqual(r.shouldGenerate, false, 'ya generada este mes -> no genera');
  assert.strictEqual(r.reason, 'already_this_period', 'razón correcta');
  ok('last_generated_period = mes actual -> no genera');
}

// 5) end_date pasada -> NO genera.
{
  const r = computeRecurring({ active: true, start_date: '2026-01-01', next_run_date: '2026-06-01', end_date: '2026-06-30' }, TODAY);
  assert.strictEqual(r.shouldGenerate, false, 'end_date pasada -> no genera');
  assert.strictEqual(r.reason, 'ended', 'razón correcta');
  ok('end_date pasada -> no genera');
}

// 6) No vencida (next_run futuro) -> no genera.
{
  const r = computeRecurring({ active: true, start_date: '2026-07-01', next_run_date: '2026-08-01' }, TODAY);
  assert.strictEqual(r.shouldGenerate, false, 'futuro -> no genera');
  assert.strictEqual(r.reason, 'not_due', 'razón correcta');
  ok('next_run futuro -> no genera');
}

// 7) Inactiva (pausada) -> no genera.
{
  const r = computeRecurring({ active: false, start_date: '2026-01-01', next_run_date: '2026-01-01' }, TODAY);
  assert.strictEqual(r.shouldGenerate, false, 'inactiva -> no genera');
  assert.strictEqual(r.reason, 'inactive', 'razón correcta');
  ok('plantilla pausada -> no genera');
}

console.log(`\nTODOS LOS ASSERTS PASARON (${n} checks).`);
