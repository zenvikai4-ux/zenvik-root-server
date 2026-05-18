/**
 * gymHandler.js
 * Handles all incoming WhatsApp/Instagram messages for gym numbers.
 *
 * Flow:
 *   Incoming message
 *     → Is existing member?  → Answer query using gym knowledge base
 *     → Is existing lead?    → Continue AI pipeline conversation
 *     → New number?          → Create lead, start AI pipeline
 *
 * Pipeline stages (auto):  new → ai_chatting → interested → handoff
 * Pipeline stages (manual): handoff → visit_scheduled → visited → converted → lost
 *
 * Handoff: AI detects intent to visit/speak to owner → notifies owner via
 *          in-app notification + WhatsApp alert to gym owner number.
 */

const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── Send WhatsApp message ─────────────────────────────────────────────────
async function sendWhatsAppMessage(phoneId, token, to, message) {
  const r = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: String(to).replace(/\D/g, ''),
      type: 'text',
      text: { body: message },
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || 'WA send failed');
  return d;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Normalize phone to E.164 digits only (91XXXXXXXXXX)
 */
function normalizePhone(phone) {
  let p = String(phone).replace(/[^0-9]/g, '');
  if (p.length === 10) p = '91' + p;
  if (p.startsWith('0')) p = '91' + p.slice(1);
  return p;
}

/**
 * Send WhatsApp message using a gym's credentials
 */
async function sendGymWA(gym, to, message) {
  const phoneId = gym.whatsapp_phone_id;
  const token   = gym.whatsapp_token || process.env.ZENVIK_WA_TOKEN;
  if (!phoneId) { console.warn(`⚠️ No phone ID for gym ${gym.name}`); return; }
  const formatted = normalizePhone(to);
  await sendWhatsAppMessage(phoneId, token, formatted, message);
}

/**
 * Insert in-app notification for gym owner
 */
async function insertNotification(gymId, title, body, type = 'lead') {
  const { error } = await supabase.from('notifications').insert({
    gym_id: gymId, title, body, type, is_read: false,
  });
  if (error) console.error('Notification insert error:', error.message);
}

/**
 * Save a conversation message to lead_conversations
 */
async function saveConversation(leadId, gymId, role, message) {
  const { error } = await supabase.from('lead_conversations').insert({
    lead_id: leadId, gym_id: gymId, role, message,
  });
  if (error) console.error('Conversation save error:', error.message);
}

/**
 * Fetch last N messages for a lead (for AI context)
 */
async function getConversationHistory(leadId, limit = 10) {
  const { data } = await supabase
    .from('lead_conversations')
    .select('role, message')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return (data || []).reverse(); // oldest first
}

/**
 * Fetch gym knowledge base
 */
async function getGymKnowledge(gymId) {
  const { data } = await supabase
    .from('gym_knowledge_base')
    .select('*')
    .eq('gym_id', gymId)
    .single();
  return data || null;
}

/**
 * Fetch gym automation config
 */
async function getGymAutomationConfig(gymId) {
  const { data } = await supabase
    .from('gym_automation_config')
    .select('*')
    .eq('gym_id', gymId)
    .single();
  return data || null;
}

/**
 * Build AI system prompt from gym knowledge base
 */
function buildGymSystemPrompt(gym, knowledge) {
  const plans = Array.isArray(knowledge?.membership_plans)
    ? knowledge.membership_plans.map(p => `  - ${p.name}: ₹${p.price} / ${p.duration}${p.description ? ' (' + p.description + ')' : ''}`).join('\n')
    : 'Not specified';

  const facilities = Array.isArray(knowledge?.facilities)
    ? knowledge.facilities.join(', ')
    : 'Not specified';

  return `You are a friendly gym assistant for *${knowledge?.gym_name || gym.name}*.

${knowledge?.tagline ? `Tagline: ${knowledge.tagline}` : ''}
${knowledge?.description ? `About: ${knowledge.description}` : ''}

📍 Location: ${knowledge?.location_address || 'Contact gym for location'}
${knowledge?.location_maps_url ? `Maps: ${knowledge.location_maps_url}` : ''}

📞 Contact: ${knowledge?.phone || gym.whatsapp_number || 'Contact gym'}
${knowledge?.email ? `Email: ${knowledge.email}` : ''}
${knowledge?.website_url ? `Website: ${knowledge.website_url}` : ''}

⏰ Timings:
  Weekdays: ${knowledge?.weekday_open || '6:00 AM'} – ${knowledge?.weekday_close || '10:00 PM'}
  Weekends: ${knowledge?.weekend_open || '7:00 AM'} – ${knowledge?.weekend_close || '8:00 PM'}
  ${knowledge?.is_open_sundays === false ? 'Closed on Sundays' : 'Open on Sundays'}

💳 Membership Plans:
${plans}

🏋️ Facilities: ${facilities}

${knowledge?.current_offers ? `🎁 Current Offers: ${knowledge.current_offers}` : ''}
${knowledge?.trainer_info ? `👟 Trainers: ${knowledge.trainer_info}` : ''}
${knowledge?.additional_info ? `ℹ️ Additional Info: ${knowledge.additional_info}` : ''}

Your job:
1. Answer questions about the gym warmly and accurately using the info above.
2. Understand what the person is looking for (weight loss, muscle gain, etc.).
3. Build interest and encourage them to visit.
4. Keep replies SHORT — max 3-4 sentences. Use WhatsApp formatting (*bold*, line breaks).
5. Always respond in the same language the person used (Telugu, Hindi, or English).
6. NEVER make up information not given above. If unsure, say "our team will help you with that".
7. Do NOT mention "handoff" or "pipeline" — just be natural.`;
}

/**
 * Build member system prompt for query answering
 */
function buildMemberSystemPrompt(gym, knowledge, member) {
  return `You are a helpful assistant for *${knowledge?.gym_name || gym.name}* gym.
You are talking to an existing member named ${member.name}.

Gym info:
- Timings: ${knowledge?.weekday_open || '6 AM'} – ${knowledge?.weekday_close || '10 PM'} (weekdays), ${knowledge?.weekend_open || '7 AM'} – ${knowledge?.weekend_close || '8 PM'} (weekends)
- Facilities: ${Array.isArray(knowledge?.facilities) ? knowledge.facilities.join(', ') : 'Contact gym'}
- Phone: ${knowledge?.phone || gym.whatsapp_number || 'Contact gym'}
${knowledge?.current_offers ? `- Current Offers: ${knowledge.current_offers}` : ''}
${knowledge?.additional_info ? `- Additional Info: ${knowledge.additional_info}` : ''}

Member details:
- Name: ${member.name}
- Plan: ${member.plan || 'Not specified'}
- Membership expires: ${member.expiry_date || 'Not specified'}
- Status: ${member.status || 'active'}

Your job:
1. Answer the member's query accurately and helpfully.
2. Keep replies SHORT — max 3 sentences.
3. Respond in the same language they used.
4. For account issues (payment, plan changes), say the gym team will assist them.`;
}

/**
 * Detect if AI should hand off to the owner
 */
function shouldHandoff(message, config) {
  const defaultKeywords = ['price', 'pricing', 'fees', 'want to join', 'visit', 'come in',
    'talk to someone', 'owner', 'manager', 'call me', 'speak to', 'interested'];
  const keywords = config?.handoff_keywords || defaultKeywords;
  const lower = message.toLowerCase();
  return keywords.some(k => lower.includes(k.toLowerCase()));
}

/**
 * Detect if a lead is showing interest (for pipeline auto-advance)
 */
async function detectInterest(message) {
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      max_tokens: 5,
      messages: [
        {
          role: 'system',
          content: 'Reply only "yes" or "no". Is the person showing genuine interest in joining a gym (asking about fees, timings, membership, facilities, or expressing intent to join)?'
        },
        { role: 'user', content: message },
      ],
    });
    return completion.choices[0].message.content.toLowerCase().includes('yes');
  } catch {
    return false;
  }
}

/**
 * Generate AI reply for a lead
 */
async function generateLeadReply(message, conversationHistory, systemPrompt) {
  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory.map(c => ({
        role: c.role === 'ai' ? 'assistant' : 'user',
        content: c.message,
      })),
      { role: 'user', content: message },
    ];

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      max_tokens: 250,
      temperature: 0.7,
      messages,
    });
    return completion.choices[0].message.content;
  } catch (err) {
    console.error('Groq lead reply error:', err.message);
    return null;
  }
}

/**
 * Generate AI reply for a member query
 */
async function generateMemberReply(message, systemPrompt) {
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      max_tokens: 200,
      temperature: 0.6,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message },
      ],
    });
    return completion.choices[0].message.content;
  } catch (err) {
    console.error('Groq member reply error:', err.message);
    return null;
  }
}

// ── Main handler ──────────────────────────────────────────────────────────

/**
 * Main entry point — called for every incoming gym WhatsApp message
 * @param {string} from       - Sender phone (digits only, with country code)
 * @param {string} text       - Message text
 * @param {string} name       - Sender display name from WhatsApp
 * @param {object} gymHandler - { gymId, name, token, autoReply } from PRODUCT_HANDLERS
 * @param {string} source     - 'whatsapp' | 'instagram'
 */
async function handleGymMessage(from, text, name, gymHandler, source = 'whatsapp') {
  const { gymId } = gymHandler;

  try {
    // ── 1. Fetch gym config and knowledge in parallel ─────────────────────
    const [gymRow, knowledge, automationConfig] = await Promise.all([
      supabase.from('gyms')
        .select('id, name, whatsapp_phone_id, whatsapp_token, whatsapp_number, owner_phone')
        .eq('id', gymId)
        .single()
        .then(r => r.data),
      getGymKnowledge(gymId),
      getGymAutomationConfig(gymId),
    ]);

    if (!gymRow) {
      console.warn(`⚠️ Gym not found: ${gymId}`);
      return;
    }

    // Check if automation is enabled for this source
    if (source === 'whatsapp' && automationConfig?.whatsapp_automation_enabled === false) {
      console.log(`ℹ️ WhatsApp automation disabled for gym ${gymRow.name}`);
      return;
    }
    if (source === 'instagram' && automationConfig?.instagram_automation_enabled === false) {
      console.log(`ℹ️ Instagram automation disabled for gym ${gymRow.name}`);
      return;
    }

    const normalizedFrom = normalizePhone(from); // 91XXXXXXXXXX (12 digits)
    const tenDigit = normalizedFrom.length === 12 ? normalizedFrom.slice(2) : normalizedFrom; // XXXXXXXXXX (10 digits)
    const phoneFilter = `phone.eq.${normalizedFrom},phone.eq.${tenDigit},phone.eq.${from}`;

    // ── 2. Check if existing member ───────────────────────────────────────
    if (automationConfig?.member_query_enabled !== false) {
      const { data: member } = await supabase
        .from('members')
        .select('id, name, phone, plan, expiry_date, status')
        .eq('gym_id', gymId)
        .or(phoneFilter)
        .maybeSingle();

      if (member) {
        console.log(`👤 Existing member: ${member.name} (${gymRow.name})`);

        const memberPrompt = buildMemberSystemPrompt(gymRow, knowledge, member);
        const reply = await generateMemberReply(text, memberPrompt)
          || `Hi ${member.name}! 👋 For any queries, please contact our gym team directly.`;

        await sendGymWA(gymRow, from, reply);
        console.log(`✅ Member reply sent to ${member.name}`);
        return; // ← stop here, never enters lead pipeline
      }
    }

    // ── 3. Check if existing lead ─────────────────────────────────────────
    if (automationConfig?.lead_pipeline_enabled !== false) {
      const { data: existingLead } = await supabase
        .from('leads')
        .select('id, name, status, phone')
        .eq('gym_id', gymId)
        .or(phoneFilter)
        .not('status', 'in', '("converted","lost")')
        .maybeSingle();

      if (existingLead) {
        console.log(`🔄 Existing lead: ${existingLead.name} — stage: ${existingLead.status}`);

        // If already handed off, don't auto-reply (owner is handling)
        if (existingLead.status === 'handoff' || existingLead.status === 'visit_scheduled'
          || existingLead.status === 'visited') {
          console.log(`ℹ️ Lead ${existingLead.name} is in manual stage — skipping AI reply`);
          // Just save the message for owner to see
          await saveConversation(existingLead.id, gymId, 'lead', text);
          // Notify owner of new message
          await insertNotification(
            gymId,
            `💬 New message from ${existingLead.name}`,
            `"${text.slice(0, 100)}"`,
            'lead'
          );
          return;
        }

        // Continue AI conversation
        const history = await getConversationHistory(existingLead.id);
        const systemPrompt = buildGymSystemPrompt(gymRow, knowledge);
        const aiReply = await generateLeadReply(text, history, systemPrompt)
          || `Hi! Thanks for your message. Our team will get back to you shortly. 😊`;

        // Save both messages
        await saveConversation(existingLead.id, gymId, 'lead', text);
        await saveConversation(existingLead.id, gymId, 'ai', aiReply);

        // Send reply
        await sendGymWA(gymRow, from, aiReply);

        // Detect pipeline stage advancement
        const isHandoff = shouldHandoff(text, automationConfig);
        const isInterested = !isHandoff && await detectInterest(text);

        if (isHandoff && existingLead.status !== 'handoff') {
          // Move to handoff
          await supabase.from('leads').update({ status: 'handoff' }).eq('id', existingLead.id);
          console.log(`🔔 Lead ${existingLead.name} → handoff`);

          // Notify owner in-app
          await insertNotification(
            gymId,
            `🔔 Lead Ready — ${existingLead.name}`,
            `${existingLead.name} is interested and ready to speak with you. Message: "${text.slice(0, 80)}"`,
            'handoff'
          );

          // Alert owner on WhatsApp if they have a number
          const ownerPhone = gymRow.owner_phone || automationConfig?.owner_whatsapp;
          if (ownerPhone) {
            const ownerMsg = `🔔 *Lead Handoff — ${gymRow.name}*\n\n👤 *${existingLead.name}*\n📱 +${normalizedFrom}\n💬 "${text.slice(0, 100)}"\n\n✅ AI has handed off — this lead is ready to speak with you!`;
            await sendGymWA(gymRow, ownerPhone, ownerMsg).catch(e => console.error('Owner WA alert failed:', e.message));
          }

        } else if (isInterested && existingLead.status === 'ai_chatting') {
          // Advance to interested
          await supabase.from('leads').update({ status: 'interested' }).eq('id', existingLead.id);
          console.log(`⭐ Lead ${existingLead.name} → interested`);

        } else if (existingLead.status === 'new') {
          // First AI reply — move to ai_chatting
          await supabase.from('leads').update({ status: 'ai_chatting' }).eq('id', existingLead.id);
          console.log(`💬 Lead ${existingLead.name} → ai_chatting`);
        }

        return;
      }

      // ── 4. Brand new contact — create lead and start pipeline ───────────
      console.log(`🆕 New contact from ${from} (${gymRow.name})`);

      const systemPrompt = buildGymSystemPrompt(gymRow, knowledge);

      // Generate first AI reply
      const aiReply = await generateLeadReply(text, [], systemPrompt)
        || `Hi! 👋 Welcome to *${gymRow.name}*! We'd love to help you reach your fitness goals. What are you looking for?`;

      // Insert new lead — store phone as 10-digit for consistency with members table
      const { data: newLead, error: leadError } = await supabase
        .from('leads')
        .insert({
          gym_id: gymId,
          name: name || 'Unknown',
          phone: tenDigit, // consistent 10-digit format
          source,
          status: 'ai_chatting',
          notes: text,
        })
        .select()
        .single();

      if (leadError) {
        console.error('Lead insert error:', leadError.message);
        await sendGymWA(gymRow, from, aiReply);
        return;
      }

      // Save conversation
      await saveConversation(newLead.id, gymId, 'lead', text);
      await saveConversation(newLead.id, gymId, 'ai', aiReply);

      // Send reply
      await sendGymWA(gymRow, from, aiReply);

      // In-app notification for new lead
      await insertNotification(
        gymId,
        `🆕 New Lead — ${name || 'Unknown'}`,
        `${name || 'Someone'} messaged via ${source}: "${text.slice(0, 80)}"`,
        'lead'
      );

      console.log(`✅ New lead created and AI reply sent: ${name}`);
    }

  } catch (err) {
    console.error(`❌ handleGymMessage error (gym: ${gymId}):`, err.message);
  }
}

/**
 * Handle incoming Instagram DM for a gym
 */
async function handleGymInstagram(senderId, text, gymId) {
  const fakeHandler = { gymId };
  await handleGymMessage(senderId, text, 'Instagram User', fakeHandler, 'instagram');
}

module.exports = { handleGymMessage, handleGymInstagram };
