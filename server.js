// server.js - HYBRID Anti-Error 400 (DeepSeek V4 & GLM)
// ============================================================================
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '100mb' }));

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// ============================================================================
// 🔥 MAIN CONTROLS
// ============================================================================
const SHOW_REASONING = false; // Set false untuk sorok terus dari chat
const ENABLE_THINKING_MODE = true; 

// ============================================================================
// 🛠️ HELPER: Fungsi cuci teks untuk GLM (Classic <think> tags)
// ============================================================================
function filterClassicReasoning(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

const MODEL_MAPPING = {
  'gpt-4o': 'deepseek-ai/deepseek-v4-pro', // UPDATE KE V4 PRO
  'claude-3-sonnet': 'z-ai/glm4.7',
  'gemini-pro': 'z-ai/glm-5.1',
  'gpt-4o-latest': 'deepseek-ai/deepseek-v3.1-terminus',
};

app.post('/v1/chat/completions', async (req, res) => {
  try {
    let { model, messages, temperature, max_tokens, stream } = req.body;
    let nimModel = MODEL_MAPPING[model] || model;
    
    const isGLM = nimModel.toLowerCase().includes('glm');
    const isDeepSeekV4 = nimModel.toLowerCase().includes('deepseek-v4');

    // ============================================================================
    // 🛡️ FIX 1: SANITIZE MESSAGES 
    // ============================================================================
    let sanitizedMessages = [];
    
    for (let m of messages) {
      if (!m.content || m.content.trim() === "") continue; 
      let role = m.role === 'system' ? 'user' : m.role; 
      
      if (sanitizedMessages.length > 0 && sanitizedMessages[sanitizedMessages.length - 1].role === role) {
        sanitizedMessages[sanitizedMessages.length - 1].content += "\n\n" + m.content;
      } else {
        // DeepSeek V4 perlukan kita simpan 'reasoning_content' jika wujud di message history
        let newMsg = { role: role, content: m.content };
        if (m.reasoning_content) {
            newMsg.reasoning_content = m.reasoning_content;
        }
        sanitizedMessages.push(newMsg);
      }
    }

    // ============================================================================
    // 🛡️ FIX 2: INJECT THINKING MODE (BERBEZA IKUT MODEL)
    // ============================================================================
    if (ENABLE_THINKING_MODE && isGLM && sanitizedMessages.length > 0) {
      // GLM: Guna prompt suntikan manual (Macam asal)
      const thinkingPrompt = "\n\n[SYSTEM INSTRUCTION: You must think deeply before answering. Start your response with <think> followed by your reasoning, then close it with </think> before giving the final answer.]";
      if (sanitizedMessages[sanitizedMessages.length - 1].role === 'user') {
        sanitizedMessages[sanitizedMessages.length - 1].content += thinkingPrompt;
      } else {
         sanitizedMessages.push({ role: 'user', content: thinkingPrompt });
      }
    }

    // Persediaan Request Standard
    let nimRequest = {
      model: nimModel,
      messages: sanitizedMessages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 4096,
      stream: stream || false
    };

    // DeepSeek V4: Gunakan API Payload Khas (Native Thinking API)
    if (ENABLE_THINKING_MODE && isDeepSeekV4) {
      nimRequest.extra_body = { thinking: { type: "enabled" } };
      nimRequest.reasoning_effort = "high"; // Boleh tukar "max" atau buang
    }

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json'
    });

    // ============================================================================
    // 🛡️ STREAMING LOGIC - DIBUAT KHAS UNTUK DEEPSEEK REASONING_CONTENT
    // ============================================================================
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      let unfinishedLine = '';
      let isInsideThink = false;

      response.data.on('data', (chunk) => {
        const lines = (unfinishedLine + chunk.toString()).split('\n');
        unfinishedLine = lines.pop();

        for (let line of lines) {
          let trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          if (trimmed.includes('[DONE]')) {
            res.write('data: [DONE]\n\n');
            continue;
          }

          try {
            const jsonData = JSON.parse(trimmed.replace('data: ', ''));
            const delta = jsonData.choices[0]?.delta;
            
            if (!delta) continue;

            let sendData = false;

            // 1. Tangkap DeepSeek V4 Native Reasoning
            if (delta.reasoning_content) {
                if (SHOW_REASONING) {
                    // Kalau nak tunjuk, kita "cheat" sikit jadikan ia teks biasa pakai blockquote
                    delta.content = `> [Thinking]: ${delta.reasoning_content}\n\n`;
                    delete delta.reasoning_content; 
                    sendData = true;
                }
            } 
            // 2. Tangkap Normal Content / GLM Classic Content
            else if (delta.content !== undefined) {
                let contentStr = delta.content || "";

                if (!SHOW_REASONING) {
                    if (contentStr.includes('<think>')) isInsideThink = true;
                    
                    if (!isInsideThink && contentStr !== "") {
                        sendData = true;
                    }

                    if (contentStr.includes('</think>')) isInsideThink = false;
                } else {
                    sendData = true;
                }
            }

            // Hantar hanya jika melepasi tapisan
            if (sendData) {
                res.write(`data: ${JSON.stringify(jsonData)}\n\n`);
            }

          } catch (e) {
            // Kalau gagal parse, hantar terus untuk elak putus
            if (!isInsideThink) res.write(`${trimmed}\n\n`);
          }
        }
      });
      
      response.data.on('end', () => res.end());
      
    } else {
      // ============================================================================
      // NON-STREAMING LOGIC
      // ============================================================================
      if (!SHOW_REASONING && response.data.choices && response.data.choices[0].message) {
        let msg = response.data.choices[0].message;
        
        // Bersihkan GLM Classic
        msg.content = filterClassicReasoning(msg.content);
        
        // Bersihkan DeepSeek V4 Native
        if (msg.reasoning_content) {
            delete msg.reasoning_content;
        }
      }
      res.json(response.data);
    }

  } catch (error) {
    console.error('Proxy Error Message:', error.message);
    if (error.response && error.response.data) {
      console.error('🔥 DETEL PUNCA 400 SEBENAR:', JSON.stringify(error.response.data, null, 2));
    }
    if (!res.headersSent) {
      res.status(error.response?.status || 500).json({ 
        error: { message: error.message || 'Server error' } 
      });
    }
  }
});

app.listen(PORT, () => console.log(`🚀 Proxy V4 Hybrid up on ${PORT} | Filtering: ${!SHOW_REASONING}`));
