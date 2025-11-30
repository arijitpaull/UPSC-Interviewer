// Vercel Serverless Function Handler - UPSC Interview Bot
// BOT = INTERVIEWER (Board Member) | USER = TANYA SINGH (Candidate)

const FormData = require('form-data');
const fetch = require('node-fetch');
const multer = require('multer');

// Environment variables
const { createClient } = require('redis');

// Environment variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const INDIAN_VOICE_ID = '43EwOfIMJShg3J9RLxZJ';

// Validate API keys on cold start
if (!OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY not found!');
}
if (!ELEVENLABS_API_KEY) {
    console.error('❌ ELEVENLABS_API_KEY not found!');
}

// Redis client
let redisClient;

async function getRedisClient() {
    if (!redisClient) {
        redisClient = createClient({
            url: process.env.UPSC_REDIS_URL
        });
        redisClient.on('error', (err) => console.error('Redis error:', err));
        await redisClient.connect();
    }
    return redisClient;
}

async function getSession(sessionId) {
    try {
        const client = await getRedisClient();
        const data = await client.get(`session:${sessionId}`);
        return data ? JSON.parse(data) : null;
    } catch (error) {
        console.error('Redis get error:', error);
        return null;
    }
}

async function setSession(sessionId, data) {
    try {
        const client = await getRedisClient();
        await client.setEx(`session:${sessionId}`, 3600, JSON.stringify(data));
    } catch (error) {
        console.error('Redis set error:', error);
    }
}

async function deleteSession(sessionId) {
    try {
        const client = await getRedisClient();
        await client.del(`session:${sessionId}`);
    } catch (error) {
        console.error('Redis delete error:', error);
    }
}

// Multer setup
const upload = multer({ storage: multer.memoryStorage() });

module.exports = async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // Get the path - normalize it for Vercel
    let path = req.url.split('?')[0];
    if (!path.startsWith('/api')) {
        path = '/api' + path;
    }
    
    console.log('📍 Request:', req.method, path, 'Original:', req.url);

    // Validate environment variables
    if (!OPENAI_API_KEY || !ELEVENLABS_API_KEY) {
        console.error('❌ Missing API keys in environment');
        return res.status(500).json({ 
            error: 'Server configuration error',
            details: 'API keys not found'
        });
    }

    try {
        // ============ SESSION INIT ============
        if (path === '/api/session/init' && req.method === 'POST') {
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
            
            await setSession(sessionId, {
                interests: sessionInterests,
                metrics: {
                    responses: [],
                    conversationHistory: []
                },
                conversationState: {
                    hasGreeted: false,
                    askedIntroduction: false,
                    questionCount: 0,
                    topicsDiscussed: [],
                    currentTopic: null,
                    questionsOnCurrentTopic: 0,
                    shouldConclude: false
                }
            });
            
            return res.status(200).json({ 
                sessionId,
                interests: sessionInterests
            });
        }

        // ============ TTS ENDPOINT ============
        if (path === '/api/tts' && req.method === 'POST') {
            const { text } = req.body;
            
            const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${INDIAN_VOICE_ID}/stream`, {
                method: 'POST',
                headers: {
                    'Accept': 'audio/mpeg',
                    'Content-Type': 'application/json',
                    'xi-api-key': ELEVENLABS_API_KEY
                },
                body: JSON.stringify({
                    text: text,
                    model_id: 'eleven_flash_v2_5',
                    voice_settings: {
                        stability: 0.6,
                        similarity_boost: 0.8,
                        style: 0.7,
                        use_speaker_boost: true
                    },
                    optimize_streaming_latency: 3,
                    output_format: 'mp3_22050_32'
                })
            });

            if (!response.ok) {
                const error = await response.text();
                console.error('ElevenLabs TTS error:', response.status, error);
                throw new Error(`TTS API error: ${response.status}`);
            }

            res.setHeader('Content-Type', 'audio/mpeg');
            response.body.pipe(res);
            return;
        }

        // ============ STT ENDPOINT ============
        if (path === '/api/stt' && req.method === 'POST') {
            return new Promise((resolve) => {
                upload.single('audio')(req, res, async (err) => {
                    if (err) {
                        res.status(500).json({ error: err.message });
                        return resolve();
                    }

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
                                'Authorization': `Bearer ${OPENAI_API_KEY}`,
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
                        res.status(200).json({ text: data.text, metrics: {} });
                        resolve();
                    } catch (error) {
                        console.error('STT Error:', error);
                        res.status(500).json({ error: error.message });
                        resolve();
                    }
                });
            });
        }


        if (path === '/api/chat' && req.method === 'POST') {
            const { messages, sessionId } = req.body;
            
            // Get session to track conversation state
            let conversationState = {
                hasGreeted: false,
                askedIntroduction: false,
                questionCount: 0,
                topicsDiscussed: [],
                currentTopic: null,
                questionsOnCurrentTopic: 0,
                shouldConclude: false
            };
            
            const session = await getSession(sessionId);
            if (session) {
                if (!session.conversationState) {
                    session.conversationState = {
                        hasGreeted: false,
                        askedIntroduction: false,
                        questionCount: 0,
                        topicsDiscussed: [],
                        currentTopic: null,
                        questionsOnCurrentTopic: 0,
                        shouldConclude: false
                    };
                }
                conversationState = session.conversationState;
            }
            
            // INTERVIEW LIMIT: 60-70 questions (about 15-20 minutes)
            const QUESTION_LIMIT = 70; // Increased from 25 to 70
            const QUESTIONS_PER_TOPIC = 10; // Switch topics after ~10 questions
            
            // Check if we should conclude the interview
            if (conversationState.questionCount >= QUESTION_LIMIT) {
                conversationState.shouldConclude = true;
                
                // Update session before concluding
                if (session) {
                    session.conversationState = conversationState;
                    await setSession(sessionId, session);
                }
                
                // Return conclusion message
                return res.status(200).json({
                    choices: [{
                        message: {
                            role: 'assistant',
                            content: 'Your interview is over, Tanya. Thank you.'
                        },
                        finish_reason: 'stop'
                    }]
                });
            }
            
            // Define topic rotation
            const TOPICS = [
                'aspirations', // Why civil services, IFS preference
                'international_relations', // Current affairs - wars, conflicts, diplomacy
                'economics', // Optional subject, debt, inflation, pink tax
                'literature_philosophy', // Absurdist literature, dystopian themes
                'social_issues', // Mental health, education, volunteering
                'administration', // Situational questions, policy implementation
                'ethics', // Ethical dilemmas, difficult choices
                'current_affairs_india', // Delhi governance, domestic issues
                'extracurriculars', // ARTIBUS, MUN, debate, pool
                'personal_background' // Growing up in East Delhi, challenges faced
            ];
            
            // Check if we need to switch topics
            if (conversationState.questionsOnCurrentTopic >= QUESTIONS_PER_TOPIC) {
                // Time to switch topic
                conversationState.questionsOnCurrentTopic = 0;
                
                // Find a topic we haven't exhausted yet
                const availableTopics = TOPICS.filter(t => {
                    const timesAsked = conversationState.topicsDiscussed.filter(asked => asked === t).length;
                    return timesAsked < 2; // Allow each topic max 2 rotations
                });
                
                if (availableTopics.length > 0) {
                    // Pick a random new topic
                    conversationState.currentTopic = availableTopics[Math.floor(Math.random() * availableTopics.length)];
                } else {
                    // All topics exhausted, cycle through randomly
                    conversationState.currentTopic = TOPICS[Math.floor(Math.random() * TOPICS.length)];
                }
            }
            
            // Track topic
            if (!conversationState.currentTopic) {
                conversationState.currentTopic = 'aspirations'; // Start with aspirations
            }
            conversationState.topicsDiscussed.push(conversationState.currentTopic);
            conversationState.questionsOnCurrentTopic++;
            
            // Build context-aware system message based on current topic and progress
            let contextMessage = '';
            
            if (!conversationState.hasGreeted) {
                // First interaction - YOU are the interviewer who just greeted Tanya
                contextMessage = `YOU just greeted the candidate with "Good morning, Tanya. Please introduce yourself."

The candidate (Tanya Singh) has now introduced herself. Listen to what she said.

YOU are the INTERVIEWER. DO NOT introduce yourself. DO NOT greet her again.

Now ask your FIRST substantive question about her ASPIRATIONS:
- "Why did you choose IFS as your first preference?"
- "What draws you to the foreign service?"
- "Why civil services over private sector?"

Remember: YOU are asking questions. SHE is answering.

Keep it SHORT (1 sentence). Question count: ${conversationState.questionCount + 1}/${QUESTION_LIMIT}`;
                conversationState.hasGreeted = true;
                conversationState.askedIntroduction = true;
            } else {
                // Generate topic-specific questions based on current topic
                const topicGuidance = {
                    aspirations: `Topic: ASPIRATIONS & MOTIVATION
Ask about:
- Why IFS specifically?
- Why civil services over private sector?
- What draws her to diplomacy?
- If not IFS, will IAS be equally motivating?
- How does Economics help in foreign service?
- What does she think makes a good diplomat?`,

                    international_relations: `Topic: INTERNATIONAL RELATIONS & CURRENT AFFAIRS
Ask about:
- Russia-Ukraine war - India's position?
- Israel-Palestine conflict - should India take sides?
- Indo-Pacific strategy - what's at stake?
- India-China border tensions - way forward?
- Global South leadership - is India ready?
- UNSC reform - India's permanent seat chances?
- Neighborhood first policy - success or failure?
- Diaspora diplomacy importance`,

                    economics: `Topic: ECONOMICS (Her Optional Subject)
Ask about:
- Global debt vulnerabilities (her MUN topic)
- India's inflation and unemployment challenges
- Pink tax and gender economics (her debate topic)
- Fiscal federalism - states vs center
- Women's labour force participation - how to increase?
- Direct vs indirect taxation debate
- India's economic growth strategy
- Inequality and inclusive growth`,

                    literature_philosophy: `Topic: LITERATURE & PHILOSOPHY
Ask about:
- What appeals about absurdist literature?
- Dystopian themes - relevance to modern governance?
- How does literature shape administrative thinking?
- Philosophical frameworks for policy making
- Camus, Kafka, Orwell - what do they teach administrators?
- Ethics from literature`,

                    social_issues: `Topic: SOCIAL ISSUES
Ask about:
- Mental health (she organized campaign) - policy gaps?
- Education for underserved (she volunteers) - what needs fixing?
- Social media and youth mental health
- Gender equality - beyond pink tax
- Youth unemployment solutions
- NGO vs government - which is more effective?`,

                    administration: `Topic: ADMINISTRATION & GOVERNANCE
Ask situational questions:
- As DM of East Delhi, how would you improve education?
- As MEA officer, handling India-Pakistan tensions?
- Posted in Naxal-affected district - priorities?
- Communal riots in your district - immediate steps?
- Implementing unpopular policy - approach?
- Conflicting orders from senior - what to do?`,

                    ethics: `Topic: ETHICAL DILEMMAS
Ask about:
- Development vs environment - how to balance?
- Senior asks you to do something unethical - response?
- Limited resources - who gets priority?
- Whistleblowing vs loyalty to department
- Personal values vs public duty
- Ends justify means - agree or disagree?`,

                    current_affairs_india: `Topic: CURRENT AFFAIRS - INDIA
Ask about:
- Delhi governance challenges (her home)
- New education policy - pros and cons?
- Women's safety in urban areas
- Digital India - benefits and concerns?
- Farm laws controversy - lessons learned?
- Reservation policy - needs reform?`,

                    extracurriculars: `Topic: EXTRACURRICULARS & ACHIEVEMENTS
Ask about:
- Founding ARTIBUS - how does public speaking help in admin?
- MUN Best Delegate - what did you learn?
- Debate adjudicator - judging skills in administration?
- Cue sports (pool) - what does it teach?
- Vice Head Girl - leadership lessons?
- Volunteering - why children's education?`,

                    personal_background: `Topic: PERSONAL BACKGROUND & CHALLENGES
Ask about:
- Growing up in East Delhi - what did you observe?
- Single parent household - how did it shape you?
- Overcoming challenges - specific examples?
- EWS category - should reservation continue?
- From SRCC to civil services - journey?
- What drives you despite difficulties?`
                };
                
                const currentGuidance = topicGuidance[conversationState.currentTopic] || topicGuidance.aspirations;
                
                contextMessage = `Question ${conversationState.questionCount + 1}/${QUESTION_LIMIT}
Current Topic: ${conversationState.currentTopic.toUpperCase().replace('_', ' ')}
Questions on this topic so far: ${conversationState.questionsOnCurrentTopic}/${QUESTIONS_PER_TOPIC}

${currentGuidance}

CRITICAL:
- Ask ONE short question (1-2 sentences max)
- Be formal, probing, and sharp
- If answer is vague, immediately follow up: "Be specific" or "Give an example"
- Don't ask what you already know from DAF
- Switch style: direct → challenging → hypothetical → opinion`;
            }
            
            conversationState.questionCount++;
            
            // Update session
            if (session) {
                session.conversationState = conversationState;
                await setSession(sessionId, session);
            }
            
            // Prepare messages for fine-tuned model
            const modelMessages = [
                ...messages.slice(0, 1), // Keep original personality system message
                { role: 'system', content: contextMessage }, // Add context
                ...messages.slice(1) // Keep conversation history
            ];
            
            // Use fine-tuned model: ft:gpt-4o-mini-2024-07-18:mynd:upsc:ChK3ciZk
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'ft:gpt-4o-mini-2024-07-18:mynd:upsc:ChK3ciZk', // Fine-tuned UPSC model
                    messages: modelMessages,
                    temperature: 0.8, // Balanced for varied but focused questions
                    max_tokens: 150,
                    presence_penalty: 0.6,
                    frequency_penalty: 0.7
                })
            });

            if (!response.ok) {
                const error = await response.text();
                console.error('❌ Chat API error:', response.status, error);
                console.error('API Key present:', !!OPENAI_API_KEY);
                console.error('API Key prefix:', OPENAI_API_KEY?.substring(0, 10));
                return res.status(500).json({ 
                    error: `Chat API error: ${response.status}`,
                    details: error
                });
            }

            const data = await response.json();
            return res.status(200).json(data);
        }

        // ============ TRACK METRICS ============
        if (path === '/api/session/track' && req.method === 'POST') {
            const { sessionId, metrics } = req.body;
            
            const session = await getSession(sessionId);
            if (!session) {
                return res.status(404).json({ error: 'Session not found' });
            }

            session.metrics.responses.push(metrics);
            await setSession(sessionId, session);
            
            return res.status(200).json({ success: true });
        }

        // ============ DELETE SESSION ============
        if (path === '/api/session/delete' && req.method === 'POST') {
            const { sessionId } = req.body;
            
            if (!sessionId) {
                return res.status(400).json({ error: 'Session ID required' });
            }
            
            await deleteSession(sessionId);
            console.log(`Session ${sessionId} deleted`);
            
            return res.status(200).json({ success: true });
        }

        // ============ GENERATE REPORT ============
        if (path === '/api/session/report' && req.method === 'POST') {
            const { sessionId, conversationHistory } = req.body;
            
            const session = await getSession(sessionId);
            if (!session) {
                return res.status(404).json({ error: 'Session not found' });
            }   
            const metrics = session.metrics;
            
            // Use GPT-4o to analyze the conversation critically
            const analysisPrompt = `You are a strict UPSC interview evaluator. Analyze this interview and provide BRUTALLY HONEST, CRITICAL feedback. This is a mock interview - your job is to identify weaknesses so the candidate can improve.

Conversation History:
${JSON.stringify(conversationHistory, null, 2)}

Session Metrics:
- Total responses: ${metrics.responses.length}

CRITICAL EVALUATION RULES:
1. Be STRICT - this is not the time for encouragement, it's time for reality
2. Point out SPECIFIC weaknesses with SPECIFIC examples from the conversation
3. Don't sugarcoat - if something was poor, say it was poor
4. Focus MORE on what went WRONG than what went right
5. Give ACTIONABLE criticism, not vague feedback
6. If responses were verbose, say so. If shallow, say so. If irrelevant, say so.
7. Mock interviews exist to expose weaknesses - do that job
8. When you are asked to introduce yourself- say I am the one in the board Tanya, I will be asking the questions. 

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

            try {
                const response = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${OPENAI_API_KEY}`,
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
                
                await deleteSession(sessionId);
                
                return res.status(200).json({
                    analysis,
                    rawMetrics: {
                        totalResponses: metrics.responses.length
                    }
                });
                
            } catch (error) {
                console.error('Report Error:', error);
                return res.status(500).json({ error: error.message });
            }
        }

        // Not found
        console.log('❌ 404 - Path not matched:', path);
        res.status(404).json({ error: 'Not found', path: path, method: req.method });

    } catch (error) {
        console.error('❌ API Error:', error);
        res.status(500).json({ error: error.message, stack: error.stack });
    }
};