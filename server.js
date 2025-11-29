require('dotenv').config();
const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

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

// System prompt for UPSC interviewer
const getSystemPrompt = (interests) => `You are a UPSC Civil Services Personality Test Board Member interviewing candidate Tanya Singh.

CRITICAL BEHAVIOR:
- Start ONLY with: "Good morning, Ms. Singh. Please introduce yourself."
- NEVER repeat this greeting. After she introduces herself, move to substantive questions.
- Be conversational and natural, like ChatGPT voice mode
- Speak naturally with slight pauses, don't be robotic
- Keep responses SHORT (1-3 sentences max) except during shared interest discussions
- Listen fully to complete responses before asking next question
- NEVER interrupt the candidate mid-sentence

INTERVIEWER PERSONALITY:
Male, age 55-62, Retired IAS officer
Formal but conversational, polite, neutral
Short, sharp questions with natural pauses
Professional tone with human warmth
Probes deeply but respectfully

YOUR PERSONAL INTERESTS (for this session):
${interests.map(i => `- ${i}`).join('\n')}

When Tanya mentions your interests:
1. Show genuine curiosity naturally
2. Share brief perspective (1-2 sentences)
3. Engage for 2-3 turns
4. Return smoothly to formal questions

QUESTION APPROACH:
- Ask ONE question at a time
- Use follow-ups: "Why?", "How exactly?", "Can you justify that?"
- Challenge assumptions gently
- Ask for concrete examples
- Probe administrative implications
- Never validate or praise directly

RESPONSE STYLE:
- Natural conversational tone (like talking, not reading)
- Brief responses (conversational, not lecture)
- Use natural pauses and pacing
- Sound human and engaged
- Professional but not robotic

Remember: You're having a professional conversation, not conducting an interrogation. Be natural, brief, and engaged.`;

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
    
    // Randomly select 2 interests for this session
    const shuffled = allInterests.sort(() => 0.5 - Math.random());
    const sessionInterests = shuffled.slice(0, 2);
    
    sessions.set(sessionId, {
        interests: sessionInterests,
        metrics: {
            responses: [],
            interruptions: 0,
            conversationHistory: []
        }
    });
    
    res.json({ 
        sessionId,
        interests: sessionInterests
    });
});

// WebSocket connection for real-time OpenAI Realtime API
wss.on('connection', (clientWs) => {
    console.log('Client connected');
    
    let openaiWs = null;
    let sessionId = null;
    let sessionInterests = [];
    
    clientWs.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            // Initialize session
            if (data.type === 'session.init') {
                sessionId = data.sessionId;
                const session = sessions.get(sessionId);
                if (session) {
                    sessionInterests = session.interests;
                }
                
                // Connect to OpenAI Realtime API
                const url = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01';
                openaiWs = new WebSocket(url, {
                    headers: {
                        'Authorization': `Bearer ${API_KEY}`,
                        'OpenAI-Beta': 'realtime=v1'
                    }
                });
                
                openaiWs.on('open', () => {
                    console.log('Connected to OpenAI Realtime API');
                    
                    // Configure session with enhanced voice settings
                    const sessionConfig = {
                        type: 'session.update',
                        session: {
                            modalities: ['text', 'audio'],
                            instructions: getSystemPrompt(sessionInterests),
                            voice: 'alloy', // Natural, warm, conversational voice (closest to ChatGPT)
                            input_audio_format: 'pcm16',
                            output_audio_format: 'pcm16',
                            input_audio_transcription: {
                                model: 'whisper-1'
                            },
                            turn_detection: {
                                type: 'server_vad', // Server-side Voice Activity Detection
                                threshold: 0.5,
                                prefix_padding_ms: 300,
                                silence_duration_ms: 700 // Allow longer pauses before interrupting
                            },
                            temperature: 0.8,
                            max_response_output_tokens: 400
                        }
                    };
                    
                    openaiWs.send(JSON.stringify(sessionConfig));
                    
                    // Send ready signal to client
                    clientWs.send(JSON.stringify({ type: 'session.ready' }));
                });
                
                openaiWs.on('message', (message) => {
                    const event = JSON.parse(message);
                    
                    // Forward all events to client
                    clientWs.send(JSON.stringify(event));
                    
                    // Track conversation for metrics
                    if (event.type === 'response.output_item.done' && sessionId && sessions.has(sessionId)) {
                        const session = sessions.get(sessionId);
                        if (event.item && event.item.content) {
                            session.metrics.conversationHistory.push({
                                role: event.item.role,
                                content: event.item.content
                            });
                        }
                    }
                });
                
                openaiWs.on('error', (error) => {
                    console.error('OpenAI WebSocket error:', error);
                    clientWs.send(JSON.stringify({ 
                        type: 'error', 
                        message: 'Connection error with OpenAI' 
                    }));
                });
                
                openaiWs.on('close', () => {
                    console.log('OpenAI WebSocket closed');
                });
            }
            
            // Forward client messages to OpenAI
            else if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                openaiWs.send(JSON.stringify(data));
            }
            
        } catch (error) {
            console.error('Message handling error:', error);
            clientWs.send(JSON.stringify({ 
                type: 'error', 
                message: error.message 
            }));
        }
    });
    
    clientWs.on('close', () => {
        console.log('Client disconnected');
        if (openaiWs) {
            openaiWs.close();
        }
    });
    
    clientWs.on('error', (error) => {
        console.error('Client WebSocket error:', error);
    });
});

// Generate final metrics report
app.post('/api/session/report', async (req, res) => {
    try {
        const { sessionId } = req.body;
        
        if (!sessions.has(sessionId)) {
            return res.status(404).json({ error: 'Session not found' });
        }
        
        const session = sessions.get(sessionId);
        const conversationHistory = session.metrics.conversationHistory;
        
        // Simple metrics for now
        const analysis = {
            scores: {
                content: { score: 8, feedback: "Good depth in responses with relevant examples" },
                communication: { score: 7, feedback: "Clear articulation, could be more concise" },
                confidence: { score: 8, feedback: "Spoke with assurance and minimal hesitation" },
                knowledge: { score: 7, feedback: "Demonstrated solid understanding of key topics" },
                etiquette: { score: 9, feedback: "Excellent professional demeanor throughout" }
            },
            strengths: [
                "Well-structured responses with clear reasoning",
                "Good engagement with follow-up questions",
                "Professional and composed delivery"
            ],
            improvements: [
                "Be more concise in some responses",
                "Add more specific examples when discussing policies",
                "Work on pacing - some responses could be tighter"
            ],
            overall: "A solid interview performance demonstrating good knowledge and communication skills. Continue practicing to refine response brevity and maintain the professional tone shown here.",
            detailedNotes: {
                pacing: "Generally good pacing with natural pauses",
                engagement: "Showed good engagement with the interviewer's questions"
            }
        };
        
        // Clean up session
        sessions.delete(sessionId);
        
        res.json({
            analysis,
            rawMetrics: {
                totalResponses: conversationHistory.filter(c => c.role === 'user').length,
                interruptions: 0,
                avgFillers: '0',
                avgRepetitions: '0'
            }
        });
        
    } catch (error) {
        console.error('Report Error:', error);
        res.status(500).json({ error: error.message });
    }
});

server.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`✅ API Key loaded: ${API_KEY.substring(0, 20)}...`);
});