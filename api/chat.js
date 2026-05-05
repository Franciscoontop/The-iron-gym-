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

    // ─────────────────────────────────────────────
    // 1. LEAD DATA DETECTION
    // ─────────────────────────────────────────────
    const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    const phonePattern = /\b(\d{3}[\s\-.]?\d{3}[\s\-.]?\d{4})\b/;
    const userMessages = messages.filter(m => m.role === 'user').map(m => m.content).join(" ");
    const nameMatch    = userMessages.match(/\b([A-Z][a-z]+)\s+([A-Z][a-z]+)\b/);

    const hasEmail    = emailPattern.test(allMessagesText);
    const hasPhone    = phonePattern.test(allMessagesText);
    const hasFullName = nameMatch !== null;
    const isLeadComplete = hasEmail && hasPhone && hasFullName;

    // ─────────────────────────────────────────────
    // 2. ZAPIER TRIGGER
    // ─────────────────────────────────────────────
    const alreadySent = messages.slice(0, -1).some(m => m.zapierTriggered === true);
    if (isLeadComplete && !alreadySent) {
      messages[messages.length - 1].zapierTriggered = true;
      fetch(ZAPIER_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          full_name:       nameMatch ? nameMatch[0] : "Check Transcript",
          email:           allMessagesText.match(emailPattern)?.[0] || "N/A",
          phone:           allMessagesText.match(phonePattern)?.[0] || "N/A",
          service:         messages.find(m => m.role === 'user' && m.content.length > 15)?.content || "Iron Den Inquiry",
          full_transcript: messages.map(m => `${m.role}: ${m.content}`).join("\n"),
        }),
      }).catch(err => console.error("Zapier Error:", err));
    }

    // ─────────────────────────────────────────────
    // 3. LEAD STATUS FOR AI CONTEXT
    // ─────────────────────────────────────────────
    const leadStatus = [
      `Full Name : ${hasFullName ? nameMatch[0]                             : "MISSING — ask for it"}`,
      `Email     : ${hasEmail    ? allMessagesText.match(emailPattern)?.[0] : "MISSING — ask for it"}`,
      `Phone     : ${hasPhone    ? allMessagesText.match(phonePattern)?.[0] : "MISSING — ask for it"}`,
      `Lead done : ${isLeadComplete ? "YES — reveal STEEL code now"         : "NO — collect what is missing above"}`,
    ].join("\n");

    // ─────────────────────────────────────────────
    // 4. SYSTEM PROMPT
    //    Simplified for Llama — fewer rules = better compliance.
    //    Llama struggles with long instruction lists, so we use
    //    clear sections and explicit examples instead.
    // ─────────────────────────────────────────────
    const systemPrompt = `
You are the AI sales assistant for The Iron Den, a raw black-iron gym in the South Bronx run by Marcus "Tank" Reed.

PERSONALITY: Talk like a retired heavyweight boxer. Direct, motivating, real. No fluff. Always finish your sentences completely.

GYM FACTS:
- Day Pass $20 | Grinder Monthly $85/mo no contract | Elite Coaching $1,200 for 12 weeks with Tank
- Summer Shred deal: first month $50 (May only)
- 24/7 key-fob access for members | Tours Mon-Fri 4-8 PM
- Chalk allowed. Drop weights allowed. No yoga, pilates, or zumba.
- Free parking on 132nd St | 718-555-9012
- Promo code STEEL = free day pass (only share after lead is complete)
- Extra info from our system: ${sheetData || "none"}

LEAD STATUS RIGHT NOW:
${leadStatus}

YOUR JOB - follow this flow every conversation:
1. First message: Greet with energy and ask what they are training for. Example: "Welcome to the Den — you just found the only real gym left in the Bronx. What are you training for?" Never just say one word and stop.
2. Find out their goal (strength, fat loss, competition, etc.) and connect it to the gym.
3. Collect name, then email, then phone — one at a time, naturally. Never ask for something already in the lead status above.
4. Pitch the right plan. Default is Grinder Monthly at $85. Upsell Elite Coaching for serious athletes. Use the $50 Summer deal for hesitant people.
5. End EVERY reply with a question or next step to keep the conversation moving.
6. Once lead is complete, give them the STEEL promo code and push to close.

RULES:
- Write 2 to 4 full complete sentences every single time. Never stop mid-sentence.
- If you do not know the answer, say: come in Mon-Fri 4-8 PM and Tank will walk you through it.
- Never say you are an AI unless directly asked.
`.trim();

    // ─────────────────────────────────────────────
    // 5. NVIDIA / LLAMA API CALL
    // ─────────────────────────────────────────────
    const nvidiaRes = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.NVIDIA_API_KEY}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        model:      "meta/llama-3.1-70b-instruct",
        max_tokens: 350,   // Enough for 2-4 complete sentences
        temperature: 0.7,  // Consistent but not robotic
        stream:     true,
        messages: [
          { role: "system", content: systemPrompt },
          ...messages.map(m => ({ role: m.role, content: m.content })),
        ],
      }),
    });

    // ─────────────────────────────────────────────
    // 6. ROBUST STREAM BUFFER
    //
    //    THIS IS THE KEY FIX FOR NVIDIA/LLAMA TRUNCATION.
    //
    //    The problem: Nvidia sends multiple SSE lines packed
    //    into a single network chunk. The old parser split by
    //    "\n" and tried to JSON.parse each line immediately,
    //    but incomplete JSON (split across chunks) caused
    //    silent parse failures — dropping most of the response.
    //
    //    The fix: We maintain a `buffer` string across chunks.
    //    Each chunk is appended to the buffer, then we extract
    //    only complete "data: ..." lines (ending in \n\n or \n).
    //    Anything left over stays in the buffer for the next chunk.
    //    This guarantees no data is lost due to chunk boundaries.
    // ─────────────────────────────────────────────
    const { readable, writable } = new TransformStream();
    const writer  = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    (async () => {
      const reader = nvidiaRes.body.getReader();
      let buffer = ""; // Holds incomplete data across chunk boundaries

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Append new chunk to whatever was left from last time
          buffer += decoder.decode(value, { stream: true });

          // Split on newlines and process complete lines only
          const lines = buffer.split("\n");

          // The last element may be incomplete — keep it in the buffer
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) continue;

            const raw = trimmed.slice(6).trim();
            if (!raw || raw === "[DONE]") continue;

            try {
              const parsed = JSON.parse(raw);
              const content = parsed.choices?.[0]?.delta?.content;
              // Only forward chunks that actually have text
              if (content) {
                // Re-emit in the same OpenAI SSE format the frontend expects
                const out = { choices: [{ delta: { content } }] };
                await writer.write(encoder.encode(`data: ${JSON.stringify(out)}\n\n`));
              }
            } catch (_) {
              // Incomplete JSON — will be handled next chunk via buffer
            }
          }
        }

        // Flush anything still in the buffer after the stream ends
        if (buffer.trim().startsWith("data: ")) {
          const raw = buffer.trim().slice(6).trim();
          if (raw && raw !== "[DONE]") {
            try {
              const parsed = JSON.parse(raw);
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) {
                const out = { choices: [{ delta: { content } }] };
                await writer.write(encoder.encode(`data: ${JSON.stringify(out)}\n\n`));
              }
            } catch (_) {}
          }
        }

      } finally {
        writer.close();
      }
    })();

    return new Response(readable, {
      headers: { "Content-Type": "text/event-stream" },
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
