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
          service: messages.find(m => m.role === 'user' && m.content.length > 15)?.content || "Inquiry",
          full_transcript: messages.map(m => `${m.role}: ${m.content}`).join("\n")
        }),
      }).catch(err => console.error("Zapier Error:", err));
    }

    // --- 3. DYNAMIC SYSTEM PROMPT (Sheet-Driven Fix) ---
    const currentSheetData = sheetData || "No data provided";

    const systemPrompt = `
      ROLE: Professional AI Consultant. 
      DATABASE (STRICT ADHERENCE): ${currentSheetData}.
      
      RULES:
      1. Use the DATABASE to identify the Founder/Owner. If the database says the founder is "dog", use exactly that. Do not use any other name.
      2. Keep every response to MAX 2 short sentences.
      3. First, ask what specific task they need help with.
      4. Once explained, briefly acknowledge and ask for their Full Name, Email, and 10-digit Phone (xxx-xxx-xxxx).
      5. Do not send the final proposal until you have all 3 pieces of contact info.
      6. Be extremely polite and very concise.
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
      { 
        role: "system", 
        content: `You are the AI assistant for a business. Use the following DATABASE to answer questions. If the info isn't there, tell them to book a tour. 
        
        DATABASE: ${sheetData}` // This line is what makes it "Smart"
      },
      ...messages
    ],
    // ... rest of your code
