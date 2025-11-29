require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const FormData = require('form-data');
const multer = require('multer');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const PORT = process.env.PORT || 3000;

// Validate API keys exist
if (!OPENAI_API_KEY) {
    console.error('ERROR: OPENAI_API_KEY not found in environment variables!');
    console.error('Please create a .env file with your API key.');
    process.exit(1);
}

if (!ELEVENLABS_API_KEY) {
    console.error('ERROR: ELEVENLABS_API_KEY not found in environment variables!');
    console.error('Please add ELEVENLABS_API_KEY to your .env file.');
    process.exit(1);
}

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Session storage for metrics
const sessions = new Map();

// Endpoint to fetch available Indian accent voices from ElevenLabs
app.get('/api/voices/indian', async (req, res) => {
    try {
        const response = await fetch('https://api.elevenlabs.io/v1/voices', {
            method: 'GET',
            headers: {
                'xi-api-key': ELEVENLABS_API_KEY
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch voices: ${response.status}`);
        }

        const data = await response.json();
        
        // Filter for Indian/Hindi accent voices
        const indianVoices = data.voices.filter(voice => {
            const name = voice.name.toLowerCase();
            const labels = voice.labels || {};
            const accent = (labels.accent || '').toLowerCase();
            const description = (voice.description || '').toLowerCase();
            
            return (
                accent.includes('indian') || 
                accent.includes('hindi') ||
                name.includes('indian') ||
                name.includes('hindi') ||
                description.includes('indian') ||
                description.includes('hindi')
            );
        });

        res.json({
            total: indianVoices.length,
            voices: indianVoices.map(v => ({
                voice_id: v.voice_id,
                name: v.name,
                labels: v.labels,
                description: v.description,
                preview_url: v.preview_url
            }))
        });
        
    } catch (error) {
        console.error('Error fetching voices:', error);
        res.status(500).json({ error: error.message });
    }
});

// ElevenLabs Voice ID for Indian accent male voice
// Based on Voice Library research - using professional Indian male voices
// Top choices for UPSC interviewer (formal, authoritative, Indian accent):
// 1. "Vihan Ahuja" - Dramatic, clear Hindi/English voice (most popular)
// 2. "Aakash Aryan" - Famous Indian AI voice, conversational bass
// 3. "Ahmed J" - Professional warm Indian voice
// 4. "Viraj" - Helpful customer service voice, neutral Indian accent

// USER SELECTED VOICE - Indian accent male voice from Voice Library
// Voice ID: 43EwOfIMJShg3J9RLxZJ
// Voice Link: https://elevenlabs.io/app/voice-library?voiceId=oH8YmZXJYEZq5ScgoGn9
const INDIAN_VOICE_ID = '43EwOfIMJShg3J9RLxZJ'; // User-selected Indian voice ⭐

// Alternative voices (backup):
// const INDIAN_VOICE_ID = 'pNInz6obpgDQGcFmaJgB'; // Adam - professional male voice
// const INDIAN_VOICE_ID = 'ErXwobaYiN019PkySvjV'; // Antoni - deep authoritative voice

// Text-to-speech endpoint with ElevenLabs streaming for ultra-low latency
app.post('/api/tts', async (req, res) => {
    try {
        const { text } = req.body;
        
        // ElevenLabs streaming TTS API
        // Using eleven_flash_v2_5 for 75ms latency + natural Indian accent
        const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${INDIAN_VOICE_ID}/stream`, {
            method: 'POST',
            headers: {
                'Accept': 'audio/mpeg',
                'Content-Type': 'application/json',
                'xi-api-key': ELEVENLABS_API_KEY
            },
            body: JSON.stringify({
                text: text,
                model_id: 'eleven_flash_v2_5', // Fastest model - 75ms latency, supports 32 languages
                voice_settings: {
                    stability: 0.6, // Slightly lower for more natural variation (was 0.7)
                    similarity_boost: 0.8, // High similarity for consistent voice
                    style: 0.7, // Higher style for MORE EMOTION and modulation (was 0.4)
                    use_speaker_boost: true // Enhanced clarity
                },
                optimize_streaming_latency: 3, // Max latency optimization
                output_format: 'mp3_22050_32' // Optimized for speed and quality
            })
        });

        if (!response.ok) {
            const error = await response.text();
            console.error('ElevenLabs TTS API error:', response.status, error);
            throw new Error(`TTS API error: ${response.status}`);
        }

        // Stream the audio directly to client
        res.set('Content-Type', 'audio/mpeg');
        response.body.pipe(res);
        
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
        res.json({ text: data.text, metrics: {} });
    } catch (error) {
        console.error('STT Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Chat completion endpoint - Using fine-tuned UPSC interview model
// Chat completion endpoint - Using fine-tuned UPSC interview model
app.post('/api/chat', async (req, res) => {
    try {
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
        
        if (sessionId && sessions.has(sessionId)) {
            const session = sessions.get(sessionId);
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
            if (sessionId && sessions.has(sessionId)) {
                sessions.get(sessionId).conversationState = conversationState;
            }
            
            // Return conclusion message
            return res.json({
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
            // First interaction - user is responding to greeting
            contextMessage = `The candidate has just been greeted with "Good morning, Tanya. Please introduce yourself."

They are now responding to that greeting. Listen to their introduction.

DO NOT greet them again. DO NOT ask about basic DAF details you already know (name, age, family, education).

Ask your FIRST substantive question about ASPIRATIONS:
- "Why did you choose IFS as your first preference?"
- "What draws you to the foreign service?"
- "Why civil services?"

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
        if (sessionId && sessions.has(sessionId)) {
            sessions.get(sessionId).conversationState = conversationState;
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

// Delete session (for Stop button - no metrics needed)
app.post('/api/session/delete', (req, res) => {
    const { sessionId } = req.body;
    
    if (!sessionId) {
        return res.status(400).json({ error: 'Session ID required' });
    }
    
    if (sessions.has(sessionId)) {
        sessions.delete(sessionId);
        console.log(`Session ${sessionId} deleted (stopped without metrics)`);
    }
    
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
        
        sessions.delete(sessionId);
        
        res.json({
            analysis,
            rawMetrics: {
                totalResponses: metrics.responses.length
            }
        });
        
    } catch (error) {
        console.error('Report Error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`✅ OpenAI API Key loaded: ${OPENAI_API_KEY.substring(0, 20)}...`);
    console.log(`✅ ElevenLabs API Key loaded: ${ELEVENLABS_API_KEY.substring(0, 20)}...`);
    console.log(`🤖 Using Fine-tuned UPSC Model: ft:gpt-4o-mini-2024-07-18:mynd:upsc:ChK3ciZk`);
    console.log(`🎤 Using ElevenLabs Flash v2.5 for ultra-low latency TTS (75ms)`);
    console.log(`🗣️  Using Indian accent voice for UPSC interviewer`);
    console.log(`👤 Interviewing: Tanya Singh, Roll No. 0804181`);
    console.log(`⏱️  Interview Duration: 60-70 questions (~15-20 minutes)`);
    console.log(`🔄 Topic Rotation: Every ~10 questions across 10 domains`);
});