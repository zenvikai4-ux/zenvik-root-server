require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.options('*', cors());
app.use(express.json());

// ── ENV ───────────────────────────────────────────────
const ZENVIK_PHONE_ID = process.env.ZENVIK_PHONE_ID || '1011169425416020';
const ZENVIK_WA_TOKEN = process.env.ZENVIK_WA_TOKEN;
const OWNER_PHONE     = (process.env.OWNER_PHONE || '919491399334').replace(/\D/g, '');
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN    || 'zenvikai2024';
const GROQ_API_KEY    = process.env.GROQ_API_KEY;
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY;

const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;
const groqClient = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

// ── SYSTEM PROMPT ─────────────────────────────────────
const ZENVIK_PROMPT = `You are Zenvikai, a friendly AI assistant for Zenvik AI — business automation company in Ongole, AP, India.
Services: 1) Gym App — WhatsApp leads, memberships, fee reminders, diet plans, mobile app 2) School App — bus GPS, homework, attendance, report cards 3) Salon Automation — WhatsApp booking & reminders 4) Website Creation — live in 48 hours 5) Vendor Agent — AI vendor communication 6) Voice Agent — answers calls in Telugu/Hindi/English
Facts: Free 30-min demo, setup in 48 hours, no hidden charges. Contact: info@zenvikai.com | +91 94913 99334. Website: zenvikai.com
Rules: Reply in 2-4 sentences. Use customer's language. Never make up pricing. Always suggest free demo.`;

// ── PRODUCT REGISTRY ──────────────────────────────────
// phone_number_id → product handler
const PRODUCT_HANDLERS = {};

async function loadGymNumbers() {
  if (!supabase) return;
  try {
    const { data } = await supabase
      .from('gyms')
      .select('id, name, whatsapp_phone_id, whatsapp_token, auto_reply_message')
      .not('whatsapp_phone_id', 'is', null);
    if (!data) return;
    for (const gym of data) {
      PRODUCT_HANDLERS[gym.whatsapp_phone_id] = {
        type: 'gym', gymId: gym.id, name: gym.name,
        token: gym.whatsapp_token || ZENVIK_WA_TOKEN,
        autoReply: gym.auto_reply_message
      };
    }
    console.log(`✅ Loaded ${data.length} gym numbers`);
  } catch (e) { console.error('loadGymNumbers:', e.message); }
}

// ── HELPERS ───────────────────────────────────────────
async function sendWA(phoneId, token, to, msg) {
  const r = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: String(to).replace(/\D/g,''), type: 'text', text: { body: msg } })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || 'WA failed');
  return d;
}

const sendZenvik = (to, msg) => sendWA(ZENVIK_PHONE_ID, ZENVIK_WA_TOKEN, to, msg);

async function groqReply(prompt, text, name = 'Customer') {
  if (!groqClient) {
    console.warn('⚠️ Groq client not initialized — check GROQ_API_KEY');
    return null;
  }
  try {
    const completion = await groqClient.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      max_tokens: 200,
      temperature: 0.8,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: `${name} says: "${text}"` }
      ]
    });
    const reply = completion.choices?.[0]?.message?.content || null;
    console.log(`🤖 Groq reply: "${reply?.slice(0,60)}"`);
    return reply;
  } catch(e) {
    console.error('groqReply error:', e.message);
    return null;
  }
}

// ── MESSAGE HANDLERS ──────────────────────────────────
async function handleZenvik(from, text, name) {
  const reply = await groqReply(ZENVIK_PROMPT, text, name)
    || `Hi! Welcome to Zenvik AI 👋\n\n1 - Book Free Demo\n2 - Pricing\n3 - Our Services\n\nVisit zenvikai.com`;
  await sendZenvik(from, reply);
  const urgent = ['demo','price','cost','urgent','complaint','help','refund'].some(k => text.toLowerCase().includes(k));
  if (urgent) await sendZenvik(OWNER_PHONE, `🔔 *Zenvik Alert*\n👤 ${name} (${from})\n💬 "${text}"`).catch(()=>{});
  if (supabase) await supabase.from('zenvik_leads').insert({ name, phone: from, message: text, reply_sent: reply, needs_attention: urgent, source: 'whatsapp' }).catch(()=>{});
}

async function handleGym(from, text, name, h) {
  const reply = h.autoReply || `Hi! 👋 Thanks for reaching out to *${h.name}*. We'll get back to you shortly!\n\n_Powered by Zenvik AI_`;
  await sendWA(ZENVIK_PHONE_ID, h.token || ZENVIK_WA_TOKEN, from, reply);
  if (supabase && h.gymId) {
    await supabase.from('leads').insert({ gym_id: h.gymId, name, phone: from, source: 'whatsapp', status: 'enquiry', notes: text }).catch(()=>{});
    await supabase.from('notifications').insert({ gym_id: h.gymId, title: `📩 New Lead — ${name}`, body: `${name}: "${text.slice(0,100)}"`, type: 'lead', is_read: false }).catch(()=>{});
  }
}

// ── ROUTES ────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'Zenvik AI Root Server', version: '4.0', products: ['gym','school','salon','website','vendor','voice'] }));

// Webhook verify
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// Unified webhook
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  if (!body?.object) return;

  // WhatsApp
  if (body.object === 'whatsapp_business_account') {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;
        const val = change.value;
        const phoneId = val.metadata?.phone_number_id;
        for (const msg of val.messages || []) {
          if (msg.type !== 'text') continue;
          const from = msg.from;
          const text = msg.text?.body || '';
          const name = val.contacts?.[0]?.profile?.name || 'Customer';
          if (phoneId === ZENVIK_PHONE_ID) {
            handleZenvik(from, text, name).catch(e => console.error(e.message));
          } else if (PRODUCT_HANDLERS[phoneId]) {
            handleGym(from, text, name, PRODUCT_HANDLERS[phoneId]).catch(e => console.error(e.message));
          } else {
            console.log(`⚠️ Unknown phoneId: ${phoneId}`);
          }
        }
      }
    }
  }

  // Instagram
  if (body.object === 'instagram') {
    for (const entry of body.entry || []) {
      for (const m of entry.messaging || []) {
        const text = m.message?.text;
        if (!text) continue;
        const senderId = m.sender?.id;
        if (supabase) {
          const { data: gym } = await supabase.from('gyms').select('id,name').eq('instagram_page_id', entry.id).maybeSingle();
          if (gym) {
            await supabase.from('leads').insert({ gym_id: gym.id, name: 'Instagram User', phone: senderId, source: 'instagram', status: 'enquiry', notes: text }).catch(()=>{});
            await supabase.from('notifications').insert({ gym_id: gym.id, title: '📸 New Instagram Lead', body: `"${text.slice(0,100)}"`, type: 'lead', is_read: false }).catch(()=>{});
          } else {
            await supabase.from('zenvik_leads').insert({ name: `Instagram ${senderId}`, message: text, source: 'instagram' }).catch(()=>{});
          }
        }
      }
    }
  }
});

// Website chatbot
app.post('/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array required' });
    }
    
    if (!GROQ_API_KEY) {
      return res.json({ reply: 'Hi! I am Zenvikai. We offer Gym App, School App, Salon Automation, Website Creation, Vendor Agent and Voice Agent. Book a free demo at zenvikai.com or WhatsApp +91 94913 99334!' });
    }

    console.log(`💬 Chat request: "${messages[messages.length-1]?.content?.slice(0,50)}"`);
    
    if (!groqClient) {
      return res.json({ reply: 'Hi! I am Zenvikai. We offer Gym App, School App, Salon Automation, Website Creation, Vendor Agent and Voice Agent. Book a free demo at zenvikai.com or WhatsApp +91 94913 99334!' });
    }
    const completion = await groqClient.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      max_tokens: 250,
      temperature: 0.7,
      messages: [
        { role: 'system', content: ZENVIK_PROMPT },
        ...messages.slice(-8)
      ]
    });
    const reply = completion.choices?.[0]?.message?.content || 'Please WhatsApp us at +91 94913 99334!';
    console.log(`💬 Chat reply: "${reply.slice(0,50)}"`);
    res.json({ reply });
  } catch (e) { 
    console.error('Chat error:', e.message);
    res.json({ reply: 'Having trouble connecting. WhatsApp us at +91 94913 99334!' }); 
  }
});

// Demo form
app.post('/lead', async (req, res) => {
  try {
    const { name, phone, business, service, budget } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });
    const to = phone.replace(/\D/g,'').startsWith('91') ? phone.replace(/\D/g,'') : '91'+phone.replace(/\D/g,'');
    await sendZenvik(to, `Hi ${name}! 👋\n\nThank you for your interest in *Zenvik AI*!\n\nDemo request for *${service||'our services'}* received.\n\nOur team will reach out within 2 hours.\n\n🌐 zenvikai.com | 📧 info@zenvikai.com\n— Team Zenvik AI`);
    try {
      await sendZenvik(OWNER_PHONE, `🔔 *New Demo Request*\n\n👤 ${name}\n📱 ${phone}\n🏢 ${business||'-'}\n⚙️ ${service||'-'}\n💰 ${budget||'-'}\n⏰ ${new Date().toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})}`);
      console.log(`✅ Owner alert sent to ${OWNER_PHONE}`);
    } catch(alertErr) {
      console.error(`❌ Owner alert failed:`, alertErr.message);
    }
    if (supabase) await supabase.from('zenvik_leads').insert({ name, phone: to, message: `Demo: ${service}`, source: 'website_form', needs_attention: true }).catch(()=>{});
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── START ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Zenvik AI Root Server v4.0 on port ${PORT}`);
  await loadGymNumbers();
  setInterval(loadGymNumbers, 5 * 60 * 1000);
});
