const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');

// Inbound SMS webhook for Twilio.
// Configure this URL in the Twilio Console under your Messaging Service /
// phone number: "A MESSAGE COMES IN" → Webhook → POST → https://emiti-app.vercel.app/api/sms-webhook
//
// Twilio's Advanced Opt-Out handles the carrier-level STOP/UNSTOP/HELP keywords
// natively (it stops delivery and replies automatically). This webhook is what
// makes that flow observable and auditable on our side: we log the opt-out and
// flag the affected client so future reminders are not generated for them.

// Vercel needs the raw body to validate Twilio's signature, but it also parses
// urlencoded bodies into req.body. We reconstruct the signed payload from req.body.
const STOP_WORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'BAJA'];
const START_WORDS = ['START', 'YES', 'UNSTOP', 'ALTA'];
const HELP_WORDS = ['HELP', 'INFO', 'AYUDA'];

function twiml(message) {
  if (!message) return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${message}</Message></Response>`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const params = req.body || {};

  // Validate the request actually came from Twilio.
  const signature = req.headers['x-twilio-signature'];
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const url = `${proto}://${req.headers.host}${req.url}`;
  const valid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    signature,
    url,
    params
  );
  if (!valid) {
    console.error('[sms-webhook] Firma de Twilio inválida — rechazado');
    return res.status(403).json({ error: 'Firma inválida' });
  }

  const from = (params.From || '').trim();           // client's phone (E.164)
  const bodyRaw = (params.Body || '').trim();
  const keyword = bodyRaw.toUpperCase().replace(/[^A-Z]/g, '');

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  res.setHeader('Content-Type', 'text/xml');

  // Normalize the inbound number to the last 10 digits so it matches however the
  // phone was stored on the invoice (e.g. "787-555-1234", "(787) 555 1234").
  const last10 = from.replace(/\D/g, '').slice(-10);

  try {
    if (STOP_WORDS.includes(keyword)) {
      // Mark every invoice with this phone as opted-out so cron-reminders skips it.
      await supabase
        .from('sms_optouts')
        .upsert({ phone: last10, opted_out: true, updated_at: new Date().toISOString() }, { onConflict: 'phone' });
      console.log(`[sms-webhook] OPT-OUT registrado para ...${last10}`);
      // Twilio Advanced Opt-Out already sends the confirmation; return empty so we don't double-text.
      return res.status(200).send(twiml());
    }

    if (START_WORDS.includes(keyword)) {
      await supabase
        .from('sms_optouts')
        .upsert({ phone: last10, opted_out: false, updated_at: new Date().toISOString() }, { onConflict: 'phone' });
      console.log(`[sms-webhook] OPT-IN (reactivado) para ...${last10}`);
      return res.status(200).send(twiml());
    }

    if (HELP_WORDS.includes(keyword)) {
      console.log(`[sms-webhook] HELP solicitado por ...${last10}`);
      // Twilio's native HELP response also fires; keep ours empty to avoid duplicates.
      return res.status(200).send(twiml());
    }

    // Any other inbound message — just acknowledge, no auto-reply.
    console.log(`[sms-webhook] Mensaje entrante sin keyword de ...${last10}: "${bodyRaw.slice(0, 60)}"`);
    return res.status(200).send(twiml());
  } catch (err) {
    console.error('[sms-webhook] Error procesando webhook:', err.message);
    // Always return valid TwiML so Twilio doesn't retry/escalate.
    return res.status(200).send(twiml());
  }
};
