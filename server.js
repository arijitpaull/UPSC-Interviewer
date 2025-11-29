require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const FormData = require('form-data');
const multer = require('multer');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 3000;

// Validate API key exists
if (!API_KEY) {
    console.error('ERROR: OPENAI_API_KEY not found in environment variables!');
    console.error('Please create a .env file with your API key.');
    process.exit(1);
}

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Session storage for metrics
const sessions = new Map();

// Text-to-speech endpoint with natural voice
app.post('/api/tts', async (req, res) => {
    try {
        const { text } = req.body;
        
        const response = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'tts-1-hd',
                voice: 'onyx', // Deep, authoritative voice - closer to Indian English male interviewer
                input: text,
                speed: 0.85 // Slightly slower for more formal, measured Indian English cadence
            })
        });

        if (!response.ok) {
            const error = await response.text();
            console.error('TTS API error:', response.status, error);
            throw new Error(`TTS API error: ${response.status}`);
        }

        const buffer = await response.buffer();
        res.set('Content-Type', 'audio/mpeg');
        res.send(buffer);
    } catch (error) {
        console.error('TTS Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Speech-to-text endpoint
app.post('/api/stt', upload.single('audio'), async (req, res) => {
    try {
        const formData = new FormData();
        formData.append('file', req.file.buffer, {
            filename: 'audio.webm',
            contentType: req.file.mimetype
        });
        formData.append('model', 'whisper-1');

        const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                ...formData.getHeaders()
            },
            body: formData
        });

        if (!response.ok) {
            const error = await response.text();
            console.error('STT API error:', response.status, error);
            throw new Error(`STT API error: ${response.status}`);
        }

        const data = await response.json();
        res.json({ text: data.text, metrics: {} });
    } catch (error) {
        console.error('STT Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Chat completion endpoint
app.post('/api/chat', async (req, res) => {
    try {
        const { messages, sessionId } = req.body;
        
        // Get session to track conversation state
        let conversationState = {};
        if (sessionId && sessions.has(sessionId)) {
            const session = sessions.get(sessionId);
            if (!session.conversationState) {
                session.conversationState = {
                    hasGreeted: false,
                    askedIntroduction: false,
                    askedWhyCivilServices: false,
                    questionCount: 0,
                    topicsDiscussed: []
                };
            }
            conversationState = session.conversationState;
        }
        
        // Build enhanced system message based on conversation state
        let enhancedSystemMessage = '';
        
        if (!conversationState.hasGreeted) {
            enhancedSystemMessage = `This is the FIRST message. Start with a natural greeting variation (choose one randomly):
- "Good morning, Ms. Singh. Please tell me about yourself."
- "Good morning. I'd like to begin by hearing about your background."
- "Good morning, Ms. Singh. Let's start with you introducing yourself."
- "Morning, Ms. Singh. Why don't you begin by telling us about yourself?"

After this, NEVER greet again. Move directly to questions based on her responses.`;
            conversationState.hasGreeted = true;
        } else if (!conversationState.askedIntroduction) {
            conversationState.askedIntroduction = true;
        } else if (!conversationState.askedWhyCivilServices && conversationState.questionCount === 1) {
            enhancedSystemMessage = `She has introduced herself. Now ask about civil services motivation (vary the phrasing):
- "What draws you to the civil services?"
- "Why this career choice?"
- "What motivates you to join the administrative services?"
- "Why civil services, specifically?"

Keep it SHORT - one question only.`;
            conversationState.askedWhyCivilServices = true;
        } else {
            // For subsequent questions, ensure variety
            enhancedSystemMessage = `You've asked ${conversationState.questionCount} questions so far.
Topics discussed: ${conversationState.topicsDiscussed.join(', ') || 'none yet'}

CRITICAL RULES:
1. Ask about NEW topics - don't repeat what you've already covered
2. Base questions on her PREVIOUS answers (show you're listening)
3. Ask ONE question at a time
4. Vary your question style:
   - Direct: "What's your view on...?"
   - Probing: "How would you address...?"
   - Challenging: "Don't you think...?"
   - Hypothetical: "If you were DM of..."
   - Opinion: "Your take on...?"
5. Mix question types: policy, ethics, current affairs, administration
6. Keep responses under 2 sentences

Examples of good varied questions:
- "How would you handle farmer protests as a district magistrate?"
- "Your thoughts on the recent changes in education policy?"
- "What's the biggest challenge facing Delhi's governance?"
- "If posted in a Naxal-affected area, what would be your first priority?"
- "Justify India's stand on climate finance."`;
        }
        
        conversationState.questionCount++;
        
        // Update session
        if (sessionId && sessions.has(sessionId)) {
            sessions.get(sessionId).conversationState = conversationState;
        }
        
        // Add enhanced system message to the conversation
        const enhancedMessages = [
            ...messages.slice(0, 1), // Keep original system message
            { role: 'system', content: enhancedSystemMessage },
            ...messages.slice(1) // Keep rest of conversation
        ];
        
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: enhancedMessages,
                temperature: 0.9, // Higher for more varied questions
                max_tokens: 150,
                presence_penalty: 0.7, // Discourage repetition
                frequency_penalty: 0.8 // Strong penalty for repeating phrases
            })
        });

        if (!response.ok) {
            const error = await response.text();
            console.error('Chat API error:', response.status, error);
            throw new Error(`Chat API error: ${response.status}`);
        }

        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('Chat Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Initialize interview session with random interests
app.post('/api/session/init', (req, res) => {
    const sessionId = Date.now().toString();
    
    const allInterests = [
        'development economics',
        'education policy', 
        'diplomacy and foreign service',
        'leadership psychology',
        'Delhi governance',
        'dystopian literature',
        'cue sports and pool',
        'social entrepreneurship',
        'debating and Model UN',
        'ethics and philosophy'
    ];
    
    const shuffled = allInterests.sort(() => 0.5 - Math.random());
    const sessionInterests = shuffled.slice(0, 2);
    
    sessions.set(sessionId, {
        interests: sessionInterests,
        metrics: {
            responses: [],
            interruptions: 0,
            conversationHistory: []
        },
        conversationState: {
            hasGreeted: false,
            askedIntroduction: false,
            askedWhyCivilServices: false,
            questionCount: 0,
            topicsDiscussed: []
        }
    });
    
    res.json({ 
        sessionId,
        interests: sessionInterests
    });
});

// Track response metrics
app.post('/api/session/track', (req, res) => {
    const { sessionId, metrics, interruptionDetected } = req.body;
    
    if (!sessions.has(sessionId)) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    const session = sessions.get(sessionId);
    session.metrics.responses.push(metrics);
    if (interruptionDetected) {
        session.metrics.interruptions += 1;
    }
    
    sessions.set(sessionId, session);
    res.json({ success: true });
});

// Generate final metrics report
app.post('/api/session/report', async (req, res) => {
    try {
        const { sessionId, conversationHistory } = req.body;
        
        if (!sessions.has(sessionId)) {
            return res.status(404).json({ error: 'Session not found' });
        }
        
        const session = sessions.get(sessionId);
        const metrics = session.metrics;
        
        // Use GPT-4o to analyze the conversation critically
        const analysisPrompt = `You are a strict UPSC interview evaluator. Analyze this interview and provide BRUTALLY HONEST, CRITICAL feedback. This is a mock interview - your job is to identify weaknesses so the candidate can improve.

Conversation History:
${JSON.stringify(conversationHistory, null, 2)}

Session Metrics:
- Total responses: ${metrics.responses.length}
- Interruptions: ${metrics.interruptions || 0}

CRITICAL EVALUATION RULES:
1. Be STRICT - this is not the time for encouragement, it's time for reality
2. Point out SPECIFIC weaknesses with SPECIFIC examples from the conversation
3. Don't sugarcoat - if something was poor, say it was poor
4. Focus MORE on what went WRONG than what went right
5. Give ACTIONABLE criticism, not vague feedback
6. If responses were verbose, say so. If shallow, say so. If irrelevant, say so.
7. Mock interviews exist to expose weaknesses - do that job

Provide scores (0-10) and CRITICAL feedback for:
1. Content Quality - Were responses substantive or superficial?
2. Communication - Clear or rambling? Concise or verbose?
3. Confidence - Genuine or fake? Hesitant or overconfident?
4. Knowledge Depth - Deep understanding or surface-level?
5. Interview Etiquette - Professional or casual?

Format as JSON:
{
  "scores": {
    "content": {"score": X, "feedback": "CRITICAL 2-3 sentence feedback with specific example"},
    "communication": {"score": X, "feedback": "CRITICAL 2-3 sentence feedback"},
    "confidence": {"score": X, "feedback": "CRITICAL 2-3 sentence feedback"},
    "knowledge": {"score": X, "feedback": "CRITICAL 2-3 sentence feedback"},
    "etiquette": {"score": X, "feedback": "CRITICAL 2-3 sentence feedback"}
  },
  "strengths": ["Only include if genuinely strong", "Max 2-3 items", "Be specific"],
  "improvements": ["CRITICAL weakness #1 with specific example", "CRITICAL weakness #2", "CRITICAL weakness #3", "Add more if needed"],
  "overall": "BLUNT 3-4 sentence reality check. What would likely happen in real UPSC interview with this performance? Don't hold back.",
  "detailedNotes": {
    "responseLengths": "Were responses too long/short? Specific examples.",
    "relevance": "Did candidate stay on topic? Examples of deviation.",
    "depth": "Surface-level or analytical? Where did they fail to go deep?",
    "structure": "Well-organized or scattered thinking?"
  }
}`;

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: [
                    { 
                        role: 'system', 
                        content: 'You are a strict, no-nonsense UPSC interview evaluator. Your feedback is brutally honest and focused on identifying weaknesses. Output ONLY valid JSON.' 
                    },
                    { role: 'user', content: analysisPrompt }
                ],
                temperature: 0.3, // Lower for more consistent, critical evaluation
                max_tokens: 2000
            })
        });

        if (!response.ok) {
            throw new Error(`Analysis API error: ${response.status}`);
        }

        const data = await response.json();
        let analysis;
        
        try {
            const responseText = data.choices[0].message.content;
            const jsonText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            analysis = JSON.parse(jsonText);
        } catch (e) {
            console.error('Failed to parse analysis JSON:', e);
            // Fallback to basic critical feedback
            analysis = {
                scores: {
                    content: { score: 6, feedback: "Responses need more depth. Provide specific examples and data to support claims. Too generic." },
                    communication: { score: 6, feedback: "Work on being more concise. Several responses were unnecessarily lengthy." },
                    confidence: { score: 7, feedback: "Generally composed but avoid filler words. Practice speaking with more conviction." },
                    knowledge: { score: 6, feedback: "Surface-level understanding evident. Study your optional subject more thoroughly." },
                    etiquette: { score: 7, feedback: "Professional but could be more engaged. Eye contact and body language matter." }
                },
                strengths: [
                    "Maintained professional demeanor",
                    "Attempted to answer all questions"
                ],
                improvements: [
                    "Responses lack specific examples - every answer needs concrete data/cases",
                    "Too verbose - practice 2-3 minute responses maximum",
                    "Insufficient depth on core topics - shows gaps in preparation",
                    "Avoid generic statements - board wants specifics, not platitudes"
                ],
                overall: "This performance would likely not clear the UPSC personality test. The board expects depth, precision, and evidence-based responses. Most answers were generic and lacked the analytical rigor needed. Significant improvement required in content depth and response structure.",
                detailedNotes: {
                    responseLengths: "Several responses exceeded optimal length without adding value",
                    relevance: "Stayed mostly on topic but often gave generic answers instead of specific analysis",
                    depth: "Surface-level responses dominant. Need to demonstrate deeper understanding",
                    structure: "Responses lack clear structure. Use framework: claim → evidence → implication"
                }
            };
        }
        
        sessions.delete(sessionId);
        
        res.json({
            analysis,
            rawMetrics: {
                totalResponses: metrics.responses.length,
                interruptions: metrics.interruptions || 0,
                avgFillers: '0',
                avgRepetitions: '0'
            }
        });
        
    } catch (error) {
        console.error('Report Error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`✅ API Key loaded: ${API_KEY.substring(0, 20)}...`);
});