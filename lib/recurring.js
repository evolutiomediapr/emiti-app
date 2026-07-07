// Lógica pura de facturas recurrentes (MVP Opción B: generación client-side al
// abrir la app). Decide si una plantilla vencida debe generar una factura HOY y
// cuál es su próximo next_run_date. SIN dependencias ni side effects: testeable
// con `node`. El navegador (index.html) mantiene un espejo idéntico a mano.
//
// CATCH-UP (decisión consciente): si el usuario no abrió la app por meses, se
// genera UNA sola factura (del período actual) y next_run_date salta a la próxima
// ocurrencia del MES SIGUIENTE — NO se acumulan las atrasadas (probablemente ya
// se facturaron por otro medio; acumular crearía borradores incorrectos).

// Fechas como strings 'YYYY-MM-DD' (comparan lexicográficamente = cronológicamente).
function parseISO(s) { const [y, m, d] = String(s).split('-').map(Number); return { y, m, d }; }
function toISO(y, m, d) { return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); } // m es 1-based
function monthKey(iso) { return String(iso).slice(0, 7); }

// Próxima ocurrencia mensual: SIEMPRE en el mes siguiente al de `todayISO`,
// anclada a `anchorDay` (con clamp de fin de mes: 31 -> 28/29 en febrero).
// Garantiza una-por-mes limpia y que next_run_date siempre quede en el futuro.
function monthlyAfterMonth(todayISO, anchorDay) {
  let { y, m } = parseISO(todayISO);
  m++; if (m > 12) { m = 1; y++; }
  const d = Math.min(anchorDay, daysInMonth(y, m));
  return toISO(y, m, d);
}

// t: { active, end_date, next_run_date, last_generated_period, start_date }
// todayISO: 'YYYY-MM-DD'
// -> { shouldGenerate, newNextRunDate?, period?, reason? }
function computeRecurring(t, todayISO) {
  if (!t || t.active === false) return { shouldGenerate: false, reason: 'inactive' };
  if (t.end_date && t.end_date < todayISO) return { shouldGenerate: false, reason: 'ended' };
  if (!t.next_run_date || t.next_run_date > todayISO) return { shouldGenerate: false, reason: 'not_due' };
  const period = monthKey(todayISO);
  // Guard extra (además del lock optimista): no generar dos veces el mismo mes.
  if (t.last_generated_period === period) return { shouldGenerate: false, reason: 'already_this_period' };
  const anchorDay = parseISO(t.start_date || todayISO).d;
  return { shouldGenerate: true, newNextRunDate: monthlyAfterMonth(todayISO, anchorDay), period };
}

module.exports = { computeRecurring, monthlyAfterMonth, daysInMonth, monthKey };
