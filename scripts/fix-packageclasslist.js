// Hook de Capacitor (capacitor:copy:after en package.json).
// `cap sync/copy` regenera ios/App/App/capacitor.config.json desde los plugins
// npm detectados, botando SIEMPRE los plugins Swift LOCALES (no npm). Sin estas
// clases, el runtime de Capacitor no los registra y fallan silenciosamente.
// EmitIAPPlugin pasó 4 veces a mano antes de automatizarlo; EmitContactsPlugin
// se suma al mismo problema, por eso el hook maneja una LISTA.
const fs = require('fs');
const path = require('path');

const CONFIG = path.join(__dirname, '..', 'ios', 'App', 'App', 'capacitor.config.json');
// Insertados antes de PdfGeneratorPlugin para mantener el orden histórico.
const LOCAL_PLUGINS = ['EmitIAPPlugin', 'EmitContactsPlugin'];

try {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const list = cfg.packageClassList || [];
  const added = [];
  for (const plugin of LOCAL_PLUGINS) {
    if (list.includes(plugin)) continue;
    const i = list.indexOf('PdfGeneratorPlugin');
    list.splice(i >= 0 ? i : list.length, 0, plugin);
    added.push(plugin);
  }
  if (!added.length) {
    console.log(`[fix-packageclasslist] locales ya presentes (${LOCAL_PLUGINS.join(', ')}) — nada que hacer`);
    process.exit(0);
  }
  cfg.packageClassList = list;
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, '\t') + '\n');
  console.log(`[fix-packageclasslist] re-añadidos: ${added.join(', ')} (${list.length} clases)`);
} catch (e) {
  console.error('[fix-packageclasslist] ERROR:', e.message);
  process.exit(1);
}
