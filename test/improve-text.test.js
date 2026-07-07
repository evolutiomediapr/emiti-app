// Test de regresión para api/improve-text.js — valida el parseo y el manejo de
// refusal SIN llamar a la API real (mockea el objeto `msg` de Claude).
// Requerir el módulo es seguro: new Anthropic()/createClient solo corren dentro
// del handler, no al importar. Corre con:  node test/improve-text.test.js
const assert = require('assert');
const { parseImproveResponse, sanitizeImproved, MAX_OUT_CHARS } = require('../api/improve-text.js')._internals;

let n = 0;
const ok = (msg) => { console.log(`  ✓ ${msg}`); n++; };

// Helper: arma un `msg` de Claude con un bloque de texto que contiene el JSON dado.
const msgWith = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

console.log('improve-text — parseo y manejo de respuesta:');

// 1) Normal: JSON válido con improved -> ok + texto correcto.
{
  const r = parseImproveResponse(msgWith({ improved: 'Reparación en el baño' }));
  assert.strictEqual(r.ok, true, 'debe parsear ok');
  assert.strictEqual(r.improved, 'Reparación en el baño', 'texto correcto');
  ok('normal -> ok, texto correcto');
}

// 2) Refusal: stop_reason 'refusal' -> ok:false (no se lee content).
{
  const r = parseImproveResponse({ stop_reason: 'refusal', content: [] });
  assert.strictEqual(r.ok, false, 'refusal -> ok:false');
  ok('refusal -> ok:false');
}

// 3) Content vacío -> ok:false.
{
  const r = parseImproveResponse({ content: [] });
  assert.strictEqual(r.ok, false, 'content vacío -> ok:false');
  ok('content vacío -> ok:false');
}

// 4) JSON inválido en el bloque de texto -> ok:false.
{
  const r = parseImproveResponse({ content: [{ type: 'text', text: 'no soy json' }] });
  assert.strictEqual(r.ok, false, 'JSON inválido -> ok:false');
  ok('JSON inválido -> ok:false');
}

// 5) Comillas envolventes -> se quitan.
{
  const r = parseImproveResponse(msgWith({ improved: '"Trabajo de pintura"' }));
  assert.strictEqual(r.ok, true, 'debe parsear ok');
  assert.strictEqual(r.improved, 'Trabajo de pintura', 'sin comillas envolventes');
  ok('comillas envolventes -> se quitan');
}

// 6) Sobre-largo -> truncado a MAX_OUT_CHARS.
{
  const long = 'A'.repeat(250);
  const r = parseImproveResponse(msgWith({ improved: long }));
  assert.strictEqual(r.ok, true, 'debe parsear ok');
  assert.strictEqual(r.improved.length, MAX_OUT_CHARS, `truncado a ${MAX_OUT_CHARS}`);
  ok(`sobre-largo (250) -> truncado a ${MAX_OUT_CHARS}`);
}

// Extra: improved vacío o solo comillas -> ok:false (nada útil que mostrar).
{
  assert.strictEqual(parseImproveResponse(msgWith({ improved: '   ' })).ok, false, 'vacío -> ok:false');
  assert.strictEqual(sanitizeImproved('""'), null, 'solo comillas -> null');
  ok('improved vacío / solo comillas -> ok:false');
}

console.log(`\nTODOS LOS ASSERTS PASARON (${n} checks).`);
