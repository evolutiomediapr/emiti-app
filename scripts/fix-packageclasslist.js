// Hook de Capacitor (capacitor:copy:after en package.json).
// `cap sync/copy` regenera ios/App/App/capacitor.config.json desde los plugins
// npm detectados, botando SIEMPRE a EmitIAPPlugin (plugin Swift local, no npm).
// Pasó 4 veces a mano antes de automatizarlo — sin esta clase, el runtime de
// Capacitor no registra el plugin y las compras IAP fallan silenciosamente.
const fs = require('fs');
const path = require('path');

const CONFIG = path.join(__dirname, '..', 'ios', 'App', 'App', 'capacitor.config.json');
const LOCAL_PLUGIN = 'EmitIAPPlugin';

try {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const list = cfg.packageClassList || [];
  if (list.includes(LOCAL_PLUGIN)) {
    console.log(`[fix-packageclasslist] ${LOCAL_PLUGIN} ya presente — nada que hacer`);
    process.exit(0);
  }
  // Mantener el orden histórico: antes de PdfGeneratorPlugin
  const i = list.indexOf('PdfGeneratorPlugin');
  list.splice(i >= 0 ? i : list.length, 0, LOCAL_PLUGIN);
  cfg.packageClassList = list;
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, '\t') + '\n');
  console.log(`[fix-packageclasslist] ${LOCAL_PLUGIN} re-añadido (${list.length} clases)`);
} catch (e) {
  console.error('[fix-packageclasslist] ERROR:', e.message);
  process.exit(1);
}
