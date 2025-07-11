const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const converter = require('number-to-words');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const Tokenizer = require('sentence-tokenizer');
const app = express();
const port = 3000;

app.use(express.json());
app.use(express.static('.'));
app.use(cors());

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const conversationsDir = path.join(__dirname, 'conversations');
const audioDir = path.join(__dirname, 'audio');

fs.mkdir(conversationsDir, { recursive: true }).catch(err => console.error('Error creating conversations dir:', err));
fs.mkdir(audioDir, { recursive: true }).catch(err => console.error('Error creating audio dir:', err));

function sanitizeFilename(str) {
    return str.replace(/[^a-z0-9_ ]/gi, '').replace(/\s+/g, '_').toLowerCase();
}

function validateStringInput(str, maxLength, fieldName) {
    if (!str || typeof str !== 'string') {
        return `${fieldName} is required and must be a string`;
    }
    if (str.length > maxLength) {
        return `${fieldName} must not exceed ${maxLength} characters`;
    }
    return null;
}

app.get('/conversations', async (req, res) => {
    try {
        const files = await fs.readdir(conversationsDir);
        const ids = files.filter(file => file.endsWith('.json')).map(file => file.replace('.json', ''));
        res.json(ids);
    } catch (err) {
        console.error('Error listing conversations:', { error: err.message, stack: err.stack });
        res.status(500).json({ error: 'Failed to list conversations' });
    }
});

app.get('/conversation/:id', async (req, res) => {
    const id = req.params.id;
    const validationError = validateStringInput(id, 100, 'Conversation ID');
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }
    const filePath = path.join(conversationsDir, `${id}.json`);
    try {
        const data = await fs.readFile(filePath, 'utf8');
        res.json(JSON.parse(data));
    } catch (err) {
        if (err.code === 'ENOENT') {
            res.status(404).json({ error: 'Conversation not found' });
        } else {
            console.error('Error reading conversation:', { error: err.message, stack: err.stack });
            res.status(500).json({ error: 'Failed to read conversation' });
        }
    }
});

app.delete('/conversation/:id', async (req, res) => {
    const id = req.params.id;
    const validationError = validateStringInput(id, 100, 'Conversation ID');
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }
    const filePath = path.join(conversationsDir, `${id}.json`);
    try {
        await fs.unlink(filePath);
        res.json({ message: 'Conversation deleted' });
    } catch (err) {
        if (err.code === 'ENOENT') {
            res.status(404).json({ error: 'Conversation not found' });
        } else {
            console.error('Error deleting conversation:', { error: err.message, stack: err.stack });
            res.status(500).json({ error: 'Failed to delete conversation' });
        }
    }
});

app.get('/models', async (req, res) => {
    try {
        const fetch = (await import('node-fetch')).default;
        const response = await fetch('http://localhost:11434/api/tags');
        if (!response.ok) {
            throw new Error('Failed to fetch models');
        }
        const data = await response.json();
        res.json(data.models);
    } catch (error) {
        console.error('Error fetching models:', { error: error.message, stack: error.stack });
        res.status(500).json({ error: 'Failed to fetch models' });
    }
});

app.get('/voices', async (req, res) => {
    try {
        const voicesDir = path.join(__dirname, 'piper', 'voices');
        const files = await fs.readdir(voicesDir);
        const voices = files
            .filter(file => file.endsWith('.onnx'))
            .map(file => {
                const name = file.replace('.onnx', '');
                const parts = name.split('-');
                const lang = parts[0];
                const gender = name.includes('amy') || name.includes('lessac') || name.includes('kathleen') ? 'female' : 'male';
                return { name, lang, gender };
            });
        res.json(voices);
    } catch (err) {
        console.error('Error listing voices:', { error: err.message, stack: err.stack });
        res.status(500).json({ error: 'Failed to list voices' });
    }
});

app.post('/tts', async (req, res) => {
    const { text, voice } = req.body;
    const textError = validateStringInput(text, 5000, 'Text');
    const voiceError = validateStringInput(voice, 100, 'Voice');
    if (textError || voiceError) {
        console.error('Validation error in /tts:', { textError, voiceError });
        return res.status(400).json({ error: textError || voiceError });
    }

    const tokenizer = new Tokenizer();
    tokenizer.setEntry(text);
    let sentences = tokenizer.getSentences();
    console.log('Tokenized sentences:', sentences);
    sentences = sentences.filter(sentence => sentence.trim().length > 0);
    if (sentences.length === 0) {
        console.warn('No valid sentences after filtering:', { originalText: text });
        return res.status(400).json({ error: 'No valid text to process after filtering' });
    }

    const audioFiles = [];
    const maxChunkLength = 500;

    try {
        const piperBinary = path.join(__dirname, 'piper', 'piper.exe');
        const voiceModel = path.join(__dirname, 'piper', 'voices', `${voice}.onnx`);
        const voiceConfig = path.join(__dirname, 'piper', 'voices', `${voice}.onnx.json`);

        console.log('Piper paths:', { piperBinary, voiceModel, voiceConfig });
        await fs.access(piperBinary, fs.constants.F_OK);
        await fs.access(voiceModel, fs.constants.F_OK);
        await fs.access(voiceConfig, fs.constants.F_OK);

        for (let i = 0; i < sentences.length; i++) {
            let sentence = sentences[i];
            console.log(`Original sentence ${i}:`, { sentence });

            if (sentence.length > maxChunkLength) {
                sentence = sentence.substring(0, maxChunkLength);
                console.warn(`Truncated sentence ${i} to ${maxChunkLength} characters:`, { originalLength: sentences[i].length });
            }

            const textWithNumbersConverted = sentence.replace(/\b\d+(\.\d+)?\b/g, (match) => {
				try {
					if (match.includes('.')) {
					// Handle decimal numbers
						const [whole, fraction] = match.split('.');
						const wholeWords = converter.toWords(parseInt(whole));
						const fractionWords = fraction.split('').map(d => converter.toWords(parseInt(d))).join(' ');
						return `${wholeWords} point ${fractionWords}`;
					} else {
						return converter.toWords(parseInt(match));
					}
				} catch (err) {
					console.warn('Number conversion failed:', { number: match, error: err.message });
					return match;
				}
			});

            const cleanText = textWithNumbersConverted
                .replace(/[\p{Emoji}\p{Emoji_Presentation}\p{Emoji_Modifier_Base}\p{Emoji_Component}]+/gu, '');

            if (!cleanText.trim()) {
                console.warn(`Skipping empty sentence after preprocessing (chunk ${i}):`, { original: sentence });
                continue;
            }

            console.log(`Processing TTS chunk ${i}:`, { cleanText, voice });

            const audioFile = `output_${Date.now()}_${i}.wav`;
            const audioFilePath = path.join(audioDir, audioFile);
            const piperProcess = spawn(piperBinary, [
                '--model', voiceModel,
                '--config', voiceConfig,
                '--output_file', audioFilePath
            ]);

            let stderrData = '';
            piperProcess.stderr.on('data', (data) => {
                stderrData += data.toString();
                console.error(`Piper stderr (chunk ${i}):`, data.toString());
            });

            piperProcess.stdin.write(cleanText);
            piperProcess.stdin.end();

            await new Promise((resolve, reject) => {
                piperProcess.on('error', (err) => {
                    console.error(`Piper error (chunk ${i}):`, { error: err.message, stack: err.stack, stderr: stderrData });
                    reject(new Error(`Failed to spawn Piper process for chunk ${i}: ${err.message}`));
                });

                piperProcess.on('close', async (code) => {
                    if (code === 0) {
                        try {
                            await fs.access(audioFilePath, fs.constants.F_OK);
                            audioFiles.push(`audio/${audioFile}`);
                            resolve();
                        } catch (err) {
                            console.error(`Audio file not found (chunk ${i}):`, { error: err.message, stack: err.stack });
                            reject(new Error(`Generated audio file not found for chunk ${i}`));
                        }
                    } else {
                        console.error(`Piper process failed (chunk ${i}):`, { code, stderr: stderrData });
                        reject(new Error(`Piper process failed for chunk ${i} with code ${code}`));
                    }
                });
            });
        }

        if (audioFiles.length === 0) {
            console.error('No audio files generated after processing all chunks');
        }

        res.json({ audioFiles });
    } catch (error) {
        console.error('TTS error:', { error: error.message, stack: error.stack });
        res.json({ audioFiles: audioFiles || [] });
    }
});

app.get('/audio/:filename', async (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(audioDir, filename);
    try {
        await fs.access(filePath, fs.constants.F_OK);
        res.sendFile(filePath, (err) => {
            if (err) {
                console.error('Error sending audio file:', { error: err.message, stack: err.stack });
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Failed to send audio file' });
                }
            } else {
                fs.unlink(filePath).catch(err => console.error('Error deleting audio file:', { error: err.message, stack: err.stack }));
            }
        });
    } catch (err) {
        console.error('Audio file not found:', { error: err.message, stack: err.stack });
        res.status(404).json({ error: 'Audio file not found' });
    }
});

app.post('/query', async (req, res) => {
    let { query, conversationId, model, maxTokens } = req.body;
    const queryError = validateStringInput(query, 1000, 'Query');
    const modelError = validateStringInput(model, 100, 'Model');
    if (queryError || modelError) {
        return res.status(400).json({ error: queryError || modelError });
    }
    if (conversationId) {
        const idError = validateStringInput(conversationId, 100, 'Conversation ID');
        if (idError) {
            return res.status(400).json({ error: idError });
        }
    }
    if (maxTokens && (isNaN(maxTokens) || maxTokens < 1 || maxTokens > 1000)) {
        return res.status(400).json({ error: 'Max tokens must be a number between 1 and 1000' });
    }

    let history = [];
    if (conversationId) {
        const filePath = path.join(conversationsDir, `${conversationId}.json`);
        try {
            const data = await fs.readFile(filePath, 'utf8');
            history = JSON.parse(data);
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.error('Error reading history:', { error: err.message, stack: err.stack });
                return res.status(500).json({ error: 'Failed to read history' });
            }
            conversationId = null;
        }
    }

    if (!conversationId) {
        let title = sanitizeFilename(query).substring(0, 50);
        if (!title) {
            title = 'conversation';
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        conversationId = `${title}_${timestamp}`;
    }

    history.push({ role: 'user', content: query });

    const messages = history.map(entry => ({ role: entry.role, content: entry.content }));

    try {
        const fetch = (await import('node-fetch')).default;
        let options = {};
        if (maxTokens) {
            options.num_predict = parseInt(maxTokens);
        }
        const response = await fetch('http://localhost:11434/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: model,
                messages: messages,
                stream: false,
                options: options
            })
        });
        const data = await response.json();
        if (response.ok) {
            const dirtyanswer = data.message.content;
            const doneReason = data.done_reason;
			let answer = dirtyanswer.replace(/\*/g, '');
			const lastSentenceEndMatch = answer.match(/[.!?](?=[^.!?]*$)/);
            if (lastSentenceEndMatch) {
                // Truncate the answer string to include only up to the last sentence-ending punctuation
                // +1 to include the punctuation itself
                answer = answer.substring(0, lastSentenceEndMatch.index + 1);
            } else {
                // If no terminal punctuation is found, you might want to:
                // Option 1: Treat the whole thing as one sentence (current default of splitIntoSentences)
                // Option 2: Clear it completely if no full sentence is present (more aggressive)
                // For now, if no full stop, we leave it as is, and the client-side
                // splitIntoSentences will handle it (either as one big chunk or what it finds).
                // If you want to remove it entirely if no full stop is found:
                // answer = '';
            }
            history.push({ role: 'assistant', content: answer });
            const filePath = path.join(conversationsDir, `${conversationId}.json`);
            await fs.writeFile(filePath, JSON.stringify(history, null, 2));
            res.json({ response: answer, conversationId, doneReason });
        } else {
            console.error('Ollama error:', { error: data.error || 'Unknown' });
            res.status(500).json({ error: `Ollama error: ${data.error || 'Unknown'}` });
        }
    } catch (error) {
        console.error('Fetch error in /query:', { error: error.message, stack: error.stack });
        res.status(500).json({ error: `Fetch error: ${error.message}` });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});