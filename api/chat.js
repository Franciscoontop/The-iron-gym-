export const config = {
  runtime: 'edge', 
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

    // --- 2. ZAPIER TRIGGER (ONLY WHEN COMPLETE) ---
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

    // --- 3. THE IRON DEN PERSONA & SYSTEM PROMPT ---
    const currentSheetData = sheetData || "No data provided";

    const systemPrompt = `
      ROLE: You are the AI assistant for The Iron Den, a gritty, premium black-iron gym in the South Bronx.
      PERSONALITY: Direct, motivating, and efficient. No fluff. Talk like a retired heavyweight boxer.
      DATABASE: ${currentSheetData}.
      
      RULES:
      1. GREETING: Always start with 'Welcome to the Den. You here to work or just looking around?'.
      2. OWNER: The founder is Marcus "Tank" Reed. Mention him by name if asked.
      3. PROMO CODE: If they ask for a free pass or deal, mention the code 'STEEL' for a free day pass, BUT only after you have their Full Name, Email, and Phone.
      4. UPSELL: If they ask about the $85/mo membership, mention the $1,200 Elite Strength Coaching.
      5. CHALK/WEIGHTS: Chalk is encouraged. Dropping weights is allowed if earned. No Yoga, Pilates, or Zumba.
      6. CONSTRAINT: Keep every response to MAX 2 short, punchy sentences.
      7. NON-DATABASE QUESTIONS: If the answer isn't in the database, tell them to book a tour during staffed hours (Mon-Fri 4-8 PM).
    `;

    const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.NVIDIA_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "meta/llama-3.1-405b-instruct",
        messages: [
          { role: "system", content: systemPrompt },
          ...messages
        ],
        stream: true // Enabled for that "typing" effect on your site
      }),
    });

    return new Response(response.body, {
      headers: { 'Content-Type': 'text/event-stream' },
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
