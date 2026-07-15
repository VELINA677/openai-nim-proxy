// server.js - HYBRID Anti-Error 400 (DeepSeek V4 & GLM - CLEAN FIXED)
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
  'gpt-4o': 'deepseek-ai/deepseek-v4-pro', 
  'claude-3-sonnet': 'z-ai/glm4.7',
  'gemini-pro': 'z-ai/glm-5.2',
  'gpt-4o-latest': 'deepseek-ai/deepseek-v4-flash',
};

app.post('/v1/chat/completions', async (req, res) => {
  try {
    let { model, messages, temperature, max_tokens, stream } = req.body;
    let nimModel = MODEL_MAPPING[model] || model;
    
    const isGLM = nimModel.toLowerCase().includes('glm');

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
        let newMsg = { role: role, content: m.content };
        if (m.reasoning_content) {
            newMsg.reasoning_content = m.reasoning_content;
        }
        sanitizedMessages.push(newMsg);
      }
    }

    // ============================================================================
    // 🛡️ FIX 2: INJECT THINKING MODE (GLM ONLY)
    // ============================================================================
    if (ENABLE_THINKING_MODE && isGLM && sanitizedMessages.length > 0) {
      const thinkingPrompt = "\n\n[SYSTEM INSTRUCTION: You must think deeply before answering. Start your response with <think> followed by your reasoning, then close it with </think> before giving the final answer.]";
      if (sanitizedMessages[sanitizedMessages.length - 1].role === 'user') {
        sanitizedMessages[sanitizedMessages.length - 1].content += thinkingPrompt;
      } else {
         sanitizedMessages.push({ role: 'user', content: thinkingPrompt });
      }
    }

    // Payload standard tanpa extra_body/reasoning_effort yang menyusahkan
    let nimRequest = {
      model: nimModel,
      messages: sanitizedMessages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 4096,
      stream: stream || false
    };

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json'
    });

    // ============================================================================
    // 🛡️ STREAMING LOGIC - DEEPSEEK & GLM
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

            if (sendData) {
                res.write(`data: ${JSON.stringify(jsonData)}\n\n`);
            }

          } catch (e) {
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
        
        msg.content = filterClassicReasoning(msg.content);
        
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
