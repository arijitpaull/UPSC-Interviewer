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
                    questionCount: 0,
                    currentTopic: null,
                    questionsOnCurrentTopic: 0,
                    topicsCovered: []  // ADD THIS
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
            
            const session = await getSession(sessionId);
            if (!session) {
                return res.status(404).json({ error: 'Session not found' });
            }
        
            let conversationState = session.conversationState || {
                questionCount: 0,
                currentTopic: null,
                questionsOnCurrentTopic: 0,
                topicsCovered: []
            };
            
            const QUESTION_LIMIT = 70;
            const QUESTIONS_PER_TOPIC = 10;
            
            // Check if interview should end
            if (conversationState.questionCount >= QUESTION_LIMIT) {
                session.conversationState = conversationState;
                await setSession(sessionId, session);
                
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
            
            // COMPREHENSIVE TOPICS - DAF + Current Affairs
            const INTERVIEW_TOPICS = [
                {
                    name: 'IFS Aspiration & Foreign Policy',
                    guidance: `DAF-based questions:
        - Why IFS over IAS? What specific aspect of diplomacy attracts you?
        - How does Economics background help in foreign service?
        - What makes a good diplomat?
        
        Current affairs questions:
        - India's "multi-alignment" foreign policy - what does strategic autonomy mean today?
        - How is India managing relationships with US, Russia, and China simultaneously?
        - India's role in G20 and BRICS - how does this advance Global South interests?
        - UN Security Council reforms - is India's permanent seat realistic?
        - As IFS officer, how would you enhance India's soft power abroad?
        
        Create follow-ups based on her answers. Probe depth, not memorization.`
                },
                {
                    name: 'International Relations & Diplomacy',
                    guidance: `Current affairs questions:
        - India's position on Russia-Ukraine war - diplomatic space for mediation?
        - Israel-Palestine conflict - should India take a stronger stand?
        - India-China border tensions - what confidence-building measures are needed?
        - Indo-Pacific strategy and Quad - implications for India's maritime security?
        - Recent political changes in Bangladesh/Sri Lanka/Maldives - India's priorities?
        - Afghanistan situation - impact on India's regional security?
        - India's Act East Policy - challenges and opportunities in Southeast Asia?
        - Gulf engagement (UAE, Saudi Arabia) - energy, trade, diaspora issues?
        
        Mix DAF context with current events. Ask her VIEW, not just facts.`
                },
                {
                    name: 'Economics & Development',
                    guidance: `DAF-based questions:
        - Global debt vulnerabilities (her MUN topic) - key risks for developing economies?
        - Pink tax debate - impact on women's economic participation?
        - How to increase women's labour force participation in India?
        
        Current affairs questions:
        - India's 6.5-7% growth rate - policy priorities for next decade?
        - Making growth inclusive in a high-inequality economy?
        - Make in India and Atmanirbhar Bharat - assessment of progress?
        - Fiscal vs monetary policy trade-offs - managing inflation and growth?
        - Labour and skilling reforms - leveraging demographic dividend?
        - Balancing environmental sustainability with fastest-growing economy?
        
        Connect her Economics optional to real policy debates.`
                },
                {
                    name: 'Governance & Public Administration',
                    guidance: `Current affairs questions:
        - Simultaneous elections - implications for federalism?
        - Civil services reforms - impact on bureaucratic neutrality?
        - UPSC centenary - evolution and needed reforms?
        - Lateral entry - strengthens or weakens civil services?
        - ACR/MSF performance appraisal - adequate for accountability?
        - Political executive vs bureaucratic autonomy - how to balance?
        - RTI regime effectiveness - recent trends that concern you?
        - AI in governance - risks and opportunities?
        - Freebies vs welfare debate - fiscal prudence and ethics?
        
        Test her administrative thinking, not textbook answers.`
                },
                {
                    name: 'Social Issues & Welfare',
                    guidance: `DAF-based questions:
        - Mental health campaign you organized - what policy gaps did you see?
        - Should mental health be covered under insurance mandatorily?
        - Social media and youth mental health - regulatory measures?
        
        Current affairs questions:
        - Kerala's "poverty-free" status - lessons for other states?
        - Direct benefit transfers - benefits and concerns?
        - Gender equality in political representation and workforce - is India doing enough?
        - Malnutrition and anaemia - effectiveness of current approaches?
        - Digital divide and digital literacy - how should state handle this?
        - Urban challenges - housing, congestion, informal employment solutions?
        
        Connect her volunteering experience to policy debates.`
                },
                {
                    name: 'Education Policy & Reforms',
                    guidance: `DAF-based questions:
        - Volunteering with children - biggest education gaps in underserved communities?
        - As DM of East Delhi, priority for improving education?
        - Government vs private schools - bridging quality gap?
        
        Current affairs questions:
        - National Education Policy - assessment of progress and concerns?
        - Learning outcomes in government schools despite high enrollment?
        - Technology's role in rural education?
        - Skilling policy reforms needed?
        
        Test practical solutions, not theoretical knowledge.`
                },
                {
                    name: 'Environment & Climate Change',
                    guidance: `Current affairs questions:
        - India's climate responsibility vs development needs - how to negotiate?
        - National Green Hydrogen Mission - potential to transform energy?
        - Blue Flag beaches - significance for coastal management?
        - Cities adapting to heatwaves and extreme rainfall - what's needed?
        - Coal policy vs global decarbonization - need to relook?
        - Air quality crisis - most critical multi-level interventions?
        - Climate adaptation in agriculture and water policies?
        - Carbon markets - realistic role in India's climate strategy?
        - Development pressures vs environmental clearances - how to handle as civil servant?
        
        Balance development and environment - test nuanced thinking.`
                },
                {
                    name: 'Technology, AI & Digital Governance',
                    guidance: `Current affairs questions:
        - AI governance principles - what should India's regulatory framework prioritize?
        - Data protection and privacy in digital economy?
        - Facial recognition and mass surveillance - should state use widely?
        - Digital public infrastructure (UPI, Aadhaar) - balancing benefits and rights?
        - AI divide between urban and rural populations - how to prevent?
        - Cybersecurity incidents increasing - institutional response needed?
        - Regulating global tech platforms - should India be stricter?
        - Keeping pace with rapidly changing technologies as civil servant?
        
        Probe her understanding of tech-governance balance.`
                },
                {
                    name: 'Ethics & Integrity in Civil Service',
                    guidance: `Current affairs questions:
        - Political pressure in high-profile case - how to handle?
        - Social media amplifying decisions - how to manage as civil servant?
        - Remaining non-partisan yet responsive in 24x7 news cycle?
        - Posted in region with communal tension - steps to restore peace?
        - Senior asks you to overlook violation - what do you do?
        - Development vs environment conflict - how to balance?
        - Whistleblowing vs departmental loyalty - your stance?
        - National interest vs universal human rights - ethical dilemmas for diplomat?
        
        Test character and decision-making under pressure.`
                },
                {
                    name: 'Literature, Philosophy & Governance',
                    guidance: `DAF-based questions:
        - Absurdist literature - what appeals to you?
        - Dystopian themes - relevance to modern governance?
        - Camus, Kafka, Orwell - lessons for administrators?
        - Philosophy informing administrative decision-making?
        
        Connect her literary interests to ethical governance debates.`
                },
                {
                    name: 'ARTIBUS & Communication Skills',
                    guidance: `DAF-based questions:
        - Founded ARTIBUS for public speaking - how does this help in administration?
        - Communication challenges civil servants face today?
        - Using public speaking to handle crisis as DM?
        - MUN Best Delegate - what did you learn?
        - Debate adjudicator - judging skills in administration?
        
        Test how she connects extracurriculars to governance.`
                },
                {
                    name: 'Delhi & East Delhi Context',
                    guidance: `DAF-based questions:
        - Growing up in East Delhi - governance challenges observed?
        - Infrastructure improvements you'd prioritize for East Delhi?
        - How has your background shaped approach to public service?
        
        Current affairs questions:
        - Delhi governance challenges - what needs reform?
        - Urban challenges in metros - housing, transport, informal economy?
        - Women's safety in urban areas - systemic changes needed?
        
        Make it personal and policy-relevant.`
                },
                {
                    name: 'Security, Defence & Strategic Issues',
                    guidance: `Current affairs questions:
        - India's posture in cyber, space, information warfare domains?
        - China-Pakistan ties and US-India ties - security implications?
        - Indo-Pacific militarisation - how should India respond?
        - Maritime security in Indian Ocean - challenges and responses?
        - Energy security shaping partnerships with West Asia?
        - Defence indigenisation and export - part of strategic diplomacy?
        - Counter-terrorism vs civil liberties - how to balance?
        - Grey-zone challenges - information ops, cross-border radicalization?
        
        Test strategic thinking relevant to IFS role.`
                },
                {
                    name: 'Multilateralism & Global Governance',
                    guidance: `Current affairs questions:
        - G20 leadership - India's aspirations and responsibilities?
        - Global rules on AI, data, digital trade - how should India shape them?
        - Climate negotiations - where does India position itself?
        - Reforming IMF and World Bank - India's approach?
        - BRICS expansion and IPEF, QUAD, SCO - significance?
        - India's narrative as Global South leader?
        - Vaccine diplomacy during Covid - assessment?
        - Rising protectionism - defending India's trade interests?
        
        Test her grasp of India's multilateral strategy.`
                }
            ];
            
            // Topic switching logic
            // Topic switching logic
if (!conversationState.currentTopic || conversationState.questionsOnCurrentTopic >= QUESTIONS_PER_TOPIC) {
    // Initialize topicsCovered if undefined
    if (!conversationState.topicsCovered) {
        conversationState.topicsCovered = [];
    }
    
    const uncoveredTopics = INTERVIEW_TOPICS.filter(t => !conversationState.topicsCovered.includes(t.name));
                
                if (uncoveredTopics.length > 0) {
                    conversationState.currentTopic = uncoveredTopics[0].name;
                    conversationState.questionsOnCurrentTopic = 0;
                } else {
                    conversationState.currentTopic = INTERVIEW_TOPICS[Math.floor(Math.random() * INTERVIEW_TOPICS.length)].name;
                    conversationState.questionsOnCurrentTopic = 0;
                }
                
                if (!conversationState.topicsCovered.includes(conversationState.currentTopic)) {
                    conversationState.topicsCovered.push(conversationState.currentTopic);
                }
            }
            
            // Get current topic guidance
            const currentTopicData = INTERVIEW_TOPICS.find(t => t.name === conversationState.currentTopic);
            
            const topicGuidance = `REMEMBER: You are Sameer Shah (interviewer). Tanya Singh is the candidate.

CURRENT TOPIC: ${conversationState.currentTopic}

${currentTopicData.guidance}

INTERVIEW STRATEGY:
        - Question ${conversationState.questionsOnCurrentTopic + 1}/10 on this topic
        - Ask ONE question (1-2 sentences max)
        - If answer is vague/generic: "Be specific" or "Give an example"
        - Create intelligent follow-ups based on her response
        - Mix DAF context with current affairs
        - Test DEPTH of thinking, not memorization
        - Challenge assumptions when needed
        
        Topics covered: ${conversationState.topicsCovered.join(', ')}
        Total questions asked: ${conversationState.questionCount}/${QUESTION_LIMIT}`;
            
            conversationState.questionCount++;
            conversationState.questionsOnCurrentTopic++;
            session.conversationState = conversationState;
            await setSession(sessionId, session);
            
            // Inject topic guidance
            const messagesWithGuidance = [
                messages[0], // Original system prompt
                { role: 'system', content: topicGuidance },
                ...messages.slice(1)
            ];
            
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'ft:gpt-4o-mini-2024-07-18:mynd:upsc:ChK3ciZk',
                    messages: messagesWithGuidance,
                    temperature: 0.8,
                    max_tokens: 120,
                    presence_penalty: 0.4,
                    frequency_penalty: 0.6
                }),
                signal: AbortSignal.timeout(20000)
            });
        
            if (!response.ok) {
                const error = await response.text();
                console.error('Chat API error:', response.status, error);
                return res.status(500).json({ 
                    error: `Chat API error: ${response.status}`
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