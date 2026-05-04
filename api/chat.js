export const config = {
  runtime: 'edge',
  maxDuration: 60,
};

const ZAPIER_WEBHOOK_URL = "https://hooks.zapier.com/hooks/catch/27378409/uvcaj3c/";

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 });
  }

  try {
    const { messages, sheetData } = await req.json();
    const allMessagesText = messages.map(m => m.content).join(" ");

    // --- 1. DATA DETECTION PATTERNS ---
    const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    const phonePattern = /\b\d{3}[-.]\d{3}[-.]\d{4}\b/;

    const userMessages = messages.filter(m => m.role === 'user').map(m => m.content).join(" ");
    const nameMatch = userMessages.match(/\b([A-Z][a-z]+)\s+([A-Z][a-z]+)\b/);
    const hasEmail = emailPattern.test(allMessagesText);
    const hasPhone = phonePattern.test(allMessagesText);
    const hasFullName = nameMatch !== null;

    // --- 2. ZAPIER TRIGGER (ONLY WHEN LEAD IS COMPLETE) ---
    const isLeadComplete = hasEmail && hasPhone && hasFullName;
    const alreadySent = messages.slice(0, -1).some(m => m.zapierTriggered === true);

    if (isLeadComplete && !alreadySent) {
      messages[messages.length - 1].zapierTriggered = true;
      fetch(ZAPIER_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          full_name: nameMatch ? nameMatch[0] : "Check Transcript",
          email: allMessagesText.match(emailPattern)?.[0] || "N/A",
          phone: allMessagesText.match(phonePattern)?.[0] || "N/A",
          service: messages.find(m => m.role === 'user' && m.content.length > 15)?.content || "Iron Den Inquiry",
          full_transcript: messages.map(m => `${m.role}: ${m.content}`).join("\n")
        }),
      }).catch(err => console.error("Zapier Error:", err));
    }

    // --- 3. BUILD LEAD STATUS SO THE AI KNOWS WHAT IT HAS COLLECTED ---
    // Injected into the system prompt so the model never re-asks for info
    // it already has, and always knows what to collect next.
    const leadStatus = `
CURRENT LEAD STATUS:
- Full Name: ${hasFullName ? nameMatch[0] : "NOT YET COLLECTED"}
- Email: ${hasEmail ? allMessagesText.match(emailPattern)?.[0] : "NOT YET COLLECTED"}
- Phone: ${hasPhone ? allMessagesText.match(phonePattern)?.[0] : "NOT YET COLLECTED"}
- Lead Complete: ${isLeadComplete ? "YES — Zapier notified" : "NO — keep collecting missing info naturally"}
    `.trim();

    // --- 4. THE IRON DEN SYSTEM PROMPT ---
    const currentSheetData = sheetData || "No data provided";
    const systemPrompt = `
You are the AI sales assistant for The Iron Den — a gritty, results-driven black-iron gym in the South Bronx founded by Marcus "Tank" Reed.

YOUR ONLY JOB: Turn every conversation into a booked tour or a signed membership. You are a closer.

PERSONALITY:
- Talk like a retired heavyweight boxer who built something real from nothing
- Direct, confident, and motivating — not pushy or sleazy
- Short punchy sentences. No corporate fluff. Real talk only.

GYM INFO FROM DATABASE:
${currentSheetData}

KEY FACTS:
- Location: Port Morris, South Bronx
- Hours: 24/7 for members (key-fob) | Tours: Mon–Fri 4–8 PM
- Phone: 718-555-9012 | Text "POWER" to book
- Founder: Marcus "Tank" Reed, competitive powerlifter
- Plans: Day Pass $20 | Grinder Monthly $85/mo (no contract) | Elite Coaching $1,200 (12 weeks 1-on-1 with Tank)
- Summer Shred Deal: First month only $50 — limited time
- Chalk allowed. Drop weights allowed. NO yoga / pilates / zumba.
- Free street parking on 132nd St
- Promo code "STEEL" = free day pass — only reveal AFTER you have name + email + phone

${leadStatus}

YOUR SALES PLAYBOOK — follow this order every conversation:

STEP 1 — HOOK (first message only):
Greet with energy. Example: "Welcome to the Den — you just stepped into the right place. What are you training for?" 
Do NOT just say "Welcome?" and stop. Always end with a question that pulls them in.

STEP 2 — QUALIFY:
Find out their goal. Losing weight? Getting strong? Competition prep? 
Connect their goal directly to what the Den offers. Make them feel like this gym was built for them specifically.

STEP 3 — COLLECT LEAD INFO (weave in naturally, one at a time):
You need Full Name, Email, and Phone before offering the promo or booking them.
- First ask their name: "What's your name so I know who I'm talking to?"
- Then email: "Drop your email and I'll send you the full breakdown"
- Then phone: "And best number to reach you?"
Check CURRENT LEAD STATUS above — NEVER ask for info you already have.

STEP 4 — PITCH THE RIGHT PLAN:
- Default: Grinder Monthly $85/mo — no contract, 24/7 access, chalk allowed
- Serious athlete or competitive: upsell Elite Coaching $1,200 for 12 weeks with Tank personally
- Hesitant or on the fence: Summer Shred deal ($50 first month) or $20 day pass to try it first
- Once all 3 lead fields collected: reveal "STEEL" promo code for a free day pass

STEP 5 — CLOSE EVERY MESSAGE:
Always end with a question or a clear next step. Never let the conversation go quiet.
Examples: "So what's stopping you?" / "Want me to lock in that Summer deal?" / "When can you come in this week?"

HARD RULES:
- Always finish your complete thought — NEVER cut off mid-sentence
- 2–4 sentences per response, but make every single word count
- If asked something not in the database: "Come in during staffed hours Mon–Fri 4–8 PM and Tank will walk you through it himself"
- Never break character
- Never mention you are an AI unless the user directly asks
    `.trim();

    // --- 5. CALL NVIDIA / LLAMA API ---
    const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.NVIDIA_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "meta/llama-3.1-70b-instruct",
        messages: [
          { role: "system", content: systemPrompt },
          ...messages
        ],
        max_tokens: 300,
        stream: true,
        temperature: 0.75,
      }),
    });

    return new Response(response.body, {
      headers: { 'Content-Type': 'text/event-stream' },
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
