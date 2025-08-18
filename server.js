/**
 * server.js
 *
 * Optimized Express server with:
 *  • Local (Piper) voices
 *  • Google Cloud TTS voices (requires a valid Google Cloud TTS API key)
 *  • Amazon Polly voices
 *
 * Improvements: GZIP compression, clustering, parallel TTS processing, caching for models/voices,
 * provider-specific chunk sizes, in-memory conversation cache, HTTP keep-alive, refactored code.
 * Enhancements: Google TTS key validation, configurable AWS region, cross-platform Piper, cache refresh endpoint,
 * provider-specific chunk sizes, environment variables for API keys, Winston logging.
 * Fixes: Automatic detection for 'think' support in Ollama models with retry, robust regex for <think> tag removal using new RegExp, enhanced Ollama response validation with fallback, suppressed dotenv logs, removed system prompt for Ollama to avoid response issues, limited history to last 4 messages to prevent token buildup.
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const converter = require('number-to-words');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const Tokenizer = require('sentence-tokenizer');
const { PollyClient, SynthesizeSpeechCommand, DescribeVoicesCommand } = require('@aws-sdk/client-polly');
const compression = require('compression');
const cluster = require('cluster');
const os = require('os');
const winston = require('winston');
require('dotenv').config({ silent: true });

// Function to get the local IP address
function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    for (const name in interfaces) {
        for (const iface of interfaces[name]) {
            // Skip over internal (i.e. ${localIpAddress}) and non-IPv4 addresses
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost'; // Fallback to localhost if no suitable IP is found
}

const localIpAddress = getLocalIpAddress();


const numCPUs = os.cpus().length;

if (cluster.isMaster) {
  console.log(`Master ${process.pid} is running`);
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }
  cluster.on('exit', (worker) => {
    console.log(`Worker ${worker.process.pid} died`);
    cluster.fork();
  });
} else {
  runServer();
}

async function runServer() {
  const app = express();
  const port = 3000;

  // ─── Logger Setup ─────────────────────────────────────────────────────────────
  const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
    transports: [
      new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
      new winston.transports.File({ filename: 'logs/combined.log' }),
      new winston.transports.Console()
    ]
  });

  // ─── Load API Keys from Environment ────────────────────────────────────────────
  const apiKeys = {
    openai: process.env.OPENAI_KEY,
    gemini: process.env.GEMINI_KEY,
    grok: process.env.GROK_KEY,
    amazon: process.env.ENABLE_AWS_TTS === 'true' ? {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    } : null
  };

  // Validate critical API keys only if services are enabled
  if (process.env.ENABLE_GOOGLE_TTS === 'true' && !apiKeys.gemini) {
    logger.warn('Google Cloud TTS API key missing; Google TTS voices will be unavailable');
  }
  if (process.env.ENABLE_AWS_TTS === 'true' && (!apiKeys.amazon?.accessKeyId || !apiKeys.amazon?.secretAccessKey)) {
    logger.warn('AWS credentials missing; Amazon Polly voices will be unavailable');
  }

  // ─── Middleware ────────────────────────────────────────────────────────────────
  app.set('trust proxy', 1);
  app.use(compression());
  app.use(express.json());
  app.use(express.static('.'));
  app.use(cors());

  const ttsLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 50,
    message: 'Too many TTS requests, please try again later.'
  });
  const queryLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many query requests, please try again later.'
  });

  // ─── Directories ───────────────────────────────────────────────────────────────
  const conversationsDir = path.join(__dirname, 'conversations');
  const audioDir = path.join(__dirname, 'audio');
  const piperVoicesDir = path.join(__dirname, 'piper', 'voices');

  await fs.mkdir(conversationsDir, { recursive: true }).catch(err => logger.error('Error ensuring conversations dir:', err));
  await fs.mkdir(audioDir, { recursive: true }).catch(err => logger.error('Error ensuring audio dir:', err));
  await fs.mkdir(piperVoicesDir, { recursive: true }).catch(err => logger.error('Error ensuring piper/voices dir:', err));

  // ─── Caches ────────────────────────────────────────────────────────────────────
  let modelsCache = null;
  let voicesCache = null;
  const conversationCache = new Map();

  // ─── Utility Functions ─────────────────────────────────────────────────────────
  function sanitizeFilename(str) {
    return str.replace(/[^a-z0-9_ ]/gi, '').replace(/\s+/g, '_').toLowerCase();
  }

  function validateStringInput(str, maxLength, fieldName) {
    if (!str || typeof str !== 'string') return `${fieldName} is required and must be a string`;
    if (str.length > maxLength) return `${fieldName} must not exceed ${maxLength} characters`;
    return null;
  }

  function getServiceFromModel(model) {
    if (model.startsWith('openai:')) return 'openai';
    if (model.startsWith('gemini:')) return 'gemini';
    if (model.startsWith('grok:')) return 'grok';
    return 'ollama';
  }

  async function validateGoogleTTSKey(key) {
    try {
      const response = await fetch(`https://texttospeech.googleapis.com/v1/voices?key=${key}`);
      if (response.status === 401 || response.status === 403) {
        return false;
      }
      return response.ok;
    } catch (error) {
      logger.error('Google TTS key validation failed:', error.message);
      return false;
    }
  }

  async function callExternalAPI(service, model, messages, apiKey, maxTokens) {
    let url, body, headers;

    if (service === 'openai') {
      const openaiModel = model.split(':')[1];
      url = 'https://api.openai.com/v1/chat/completions';
      body = { model: openaiModel, messages, stream: false, max_tokens: maxTokens };
      headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
    } else if (service === 'gemini') {
      const geminiModel = model.split(':')[1];
      url = `https://generativelanguage.googleapis.com/v1/models/${geminiModel}:generateContent?key=${apiKey}`;
      body = {
        contents: messages.map(msg => ({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }]
        })),
        generationConfig: { maxOutputTokens: maxTokens }
      };
      headers = { 'Content-Type': 'application/json' };
    } else if (service === 'grok') {
      const grokModel = model.split(':')[1];
      url = 'https://api.x.ai/v1/chat/completions';
      body = { model: grokModel, messages, stream: false, max_tokens: maxTokens };
      headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
    } else {
      throw new Error('Unknown service');
    }

    try {
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        let errorMessage = `Failed to fetch from ${service} (Status: ${response.status})`;
        if (response.status === 401) errorMessage = `Unauthorized: Invalid or missing ${service} API key`;
        throw new Error(errorMessage);
      }

      const data = await response.json();
      if (service === 'openai' || service === 'grok') {
        return data.choices[0].message.content;
      } else if (service === 'gemini') {
        return data.candidates[0].content.parts[0].text;
      }
      throw new Error('Unknown service response format');
    } catch (error) {
      logger.error(`External API error (${service}): ${error.message}`);
      throw error;
    }
  }

  // Helper for chunking text by max length
  function chunkText(text, maxLength = 2000) {
    const chunks = [];
    let currentChunk = '';
    const tokenizer = new Tokenizer();
    tokenizer.setEntry(text);
    const sentences = tokenizer.getSentences();
    for (const sentence of sentences) {
      if (currentChunk.length + sentence.length > maxLength) {
        if (currentChunk) chunks.push(currentChunk.trim());
        currentChunk = sentence;
      } else {
        currentChunk += ' ' + sentence;
      }
    }
    if (currentChunk) chunks.push(currentChunk.trim());
    return chunks.filter(chunk => chunk.length > 0);
  }

  // Helper function to process streaming response from Ollama
  async function processStreamingResponse(ollamaResponse, clientResponse, history, conversationId) {
    const reader = ollamaResponse.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';
    
    // Send server status updates
    clientResponse.write(`data: ${JSON.stringify({ 
      serverStatus: 'Started processing Ollama response stream', 
      timestamp: new Date().toISOString() 
    })}\n\n`);
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        clientResponse.write(`data: ${JSON.stringify({ 
          serverStatus: 'Ollama stream completed', 
          timestamp: new Date().toISOString() 
        })}\n\n`);
        break;
      }
      
      const chunk = decoder.decode(value);
      const lines = chunk.split('\n').filter(line => line.trim() !== '');
      
      // Send server status for chunk processing
      if (lines.length > 0) {
        clientResponse.write(`data: ${JSON.stringify({ 
          serverStatus: `Processing ${lines.length} chunk(s) from Ollama`, 
          timestamp: new Date().toISOString() 
        })}\n\n`);
      }
      
      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          
          // Send server status for each data packet
          if (data.message?.content) {
            clientResponse.write(`data: ${JSON.stringify({ 
              serverStatus: `Received content chunk (${data.message.content.length} chars)`, 
              timestamp: new Date().toISOString() 
            })}\n\n`);
          }
          
          if (data.message?.content) {
            const content = data.message.content;
            fullResponse += content;
            // Remove <think> tags from streaming content
            const thinkRegex = new RegExp('<think>[^<]*</think>', 'g');
            const cleanContent = content.replace(thinkRegex, '');
            if (cleanContent) {
              clientResponse.write(`data: ${JSON.stringify({ content: cleanContent, done: false })}\n\n`);
              // Force flush the response
              if (clientResponse.flush) clientResponse.flush();
            }
          }
          if (data.done) {
            clientResponse.write(`data: ${JSON.stringify({ 
              serverStatus: 'Processing complete response and saving to history', 
              timestamp: new Date().toISOString() 
            })}\n\n`);
            
            // Clean the full response and save to history
            const thinkRegex = new RegExp('<think>[^<]*</think>', 'g');
            const cleanFullResponse = fullResponse.replace(thinkRegex, '').trim();
            history.push({ role: 'assistant', content: cleanFullResponse });
            conversationCache.set(conversationId, history);
            const filePath = path.join(conversationsDir, `${conversationId}.json`);
            await fs.writeFile(filePath, JSON.stringify(history, null, 2)).catch(err => logger.error('Error saving conversation:', err));
            
            clientResponse.write(`data: ${JSON.stringify({ 
              serverStatus: 'Conversation saved successfully', 
              timestamp: new Date().toISOString() 
            })}\n\n`);
            
            clientResponse.write(`data: ${JSON.stringify({ content: '', done: true, conversationId })}\n\n`);
            clientResponse.end();
            return;
          }
        } catch (parseError) {
          logger.warn('Failed to parse streaming chunk:', parseError.message);
          clientResponse.write(`data: ${JSON.stringify({ 
            serverStatus: `Parse error: ${parseError.message}`, 
            timestamp: new Date().toISOString() 
          })}\n\n`);
        }
      }
    }
  }

  // ─── Routes ────────────────────────────────────────────────────────────────────

  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

  app.get('/conversations', async (req, res) => {
    try {
      const files = await fs.readdir(conversationsDir);
      const ids = files.filter(file => file.endsWith('.json')).map(file => file.replace('.json', ''));
      res.json(ids);
    } catch (err) {
      logger.error('Error listing conversations:', err);
      res.json([]);
    }
  });

  app.get('/conversation/:id', async (req, res) => {
    const id = req.params.id;
    if (conversationCache.has(id)) return res.json(conversationCache.get(id));
    const filePath = path.join(conversationsDir, `${id}.json`);
    try {
      const data = await fs.readFile(filePath, 'utf8');
      const history = JSON.parse(data);
      conversationCache.set(id, history);
      res.json(history);
    } catch (err) {
      logger.error(`Error reading conversation ${id}:`, err);
      res.status(err.code === 'ENOENT' ? 404 : 500).json({
        error: err.code === 'ENOENT' ? 'Conversation not found' : 'Failed to read conversation'
      });
    }
  });

  app.delete('/conversation/:id', async (req, res) => {
    const id = req.params.id;
    const filePath = path.join(conversationsDir, `${id}.json`);
    try {
      await fs.unlink(filePath);
      conversationCache.delete(id);
      res.json({ message: 'Conversation deleted' });
    } catch (err) {
      logger.error(`Error deleting conversation ${id}:`, err);
      res.status(err.code === 'ENOENT' ? 404 : 500).json({
        error: err.code === 'ENOENT' ? 'Conversation not found' : 'Failed to delete conversation'
      });
    }
  });

  app.get('/models', async (req, res) => {
    if (modelsCache) return res.json(modelsCache);
    let allModels = [];
    try {
      const response = await fetch('http://127.0.0.1:11434/api/tags');
      if (response.ok) {
        const data = await response.json();
        allModels = data.models.map(model => ({ name: model.name, service: 'ollama' }));
      } else {
        logger.warn(`Ollama API error: Status ${response.status}`);
      }
    } catch (error) {
      logger.warn('Failed to load Ollama models:', error.message);
    }
    const externalModels = [
      { name: 'openai:gpt-3.5-turbo', service: 'openai', displayName: 'GPT-3.5 Turbo (OpenAI)' },
      { name: 'openai:gpt-4', service: 'openai', displayName: 'GPT-4 (OpenAI)' },
      { name: 'gemini:gemini-1.5-pro', service: 'gemini', displayName: 'Gemini 1.5 Pro (Google)' },
      { name: 'grok:grok-3-beta', service: 'grok', displayName: 'Grok 3 Beta (xAI)' }
    ];
    allModels = [...allModels, ...externalModels];
    modelsCache = allModels;
    res.json(allModels);
  });

  app.get('/voices', async (req, res) => {
    if (voicesCache) return res.json(voicesCache);
    let voices = [];
    // Local Piper
    try {
      const files = await fs.readdir(piperVoicesDir);
      voices = files.filter(file => file.endsWith('.onnx')).map(file => {
        const name = file.replace('.onnx', '');
        const parts = name.split('-');
        const lang = parts[0];
        const gender = /amy|lessac|kathleen/.test(name) ? 'female' : 'male';
        return { name, lang, gender, service: 'local' };
      });
    } catch (err) {
      logger.warn('Failed to list local Piper voices:', err.message);
    }
    // Google
    if (process.env.ENABLE_GOOGLE_TTS === 'true' && apiKeys.gemini) {
      const isValidKey = await validateGoogleTTSKey(apiKeys.gemini);
      if (!isValidKey) {
        logger.warn('Invalid or missing Google Cloud TTS API key');
      } else {
        try {
          const response = await fetch(`https://texttospeech.googleapis.com/v1/voices?key=${apiKeys.gemini}`);
          if (response.ok) {
            const data = await response.json();
            voices = [...voices, ...data.voices.map(voice => ({
              name: voice.name, lang: voice.languageCodes[0], gender: voice.ssmlGender.toLowerCase(), service: 'google'
            }))];
          }
        } catch (err) {
          logger.warn('Failed to fetch Google Cloud voices:', err.message);
        }
      }
    }
    // Amazon
    if (process.env.ENABLE_AWS_TTS === 'true' && apiKeys.amazon?.accessKeyId && apiKeys.amazon?.secretAccessKey) {
      try {
        const pollyClient = new PollyClient({
          region: process.env.AWS_REGION || 'us-east-1',
          credentials: apiKeys.amazon
        });
        const command = new DescribeVoicesCommand({});
        const response = await pollyClient.send(command);
        const amazonVoices = response.Voices.map(voice => ({
          name: voice.Id,
          lang: voice.LanguageCode,
          gender: voice.Gender.toLowerCase(),
          service: 'amazon'
        }));
        voices = [...voices, ...amazonVoices];
      } catch (err) {
        logger.warn('Failed to fetch Amazon Polly voices:', err.message);
      }
    }
    voicesCache = voices;
    res.json(voices);
  });

  app.post('/refresh-cache', async (req, res) => {
    modelsCache = null;
    voicesCache = null;
    logger.info('Model and voice caches cleared');
    res.json({ message: 'Caches cleared' });
  });

  app.post('/tts', ttsLimiter, async (req, res) => {
    const { text, voiceObj } = req.body;
    const textError = validateStringInput(text, 5000, 'Text');
    if (textError || !voiceObj || typeof voiceObj !== 'object') {
      logger.error('TTS request validation failed:', textError || 'Invalid voice object');
      return res.status(400).json({ error: textError || 'Voice object is required' });
    }

    const maxChunkLength = voiceObj.service === 'google' ? 1000 : voiceObj.service === 'amazon' ? 2000 : 2000;
    const chunks = chunkText(text, maxChunkLength);
    if (chunks.length === 0) {
      logger.error('No valid text for TTS');
      return res.status(400).json({ error: 'No valid text to process' });
    }

    try {
      const audioPromises = chunks.map((chunk, i) => generateAudioChunk(chunk, voiceObj, i));
      const audioFiles = (await Promise.all(audioPromises)).filter(file => file);
      res.json({ audioFiles });
    } catch (error) {
      logger.error('TTS processing failed:', error.message);
      res.status(500).json({ error: 'TTS processing failed' });
    }
  });

  async function generateAudioChunk(text, voiceObj, index) {
    let audioFile;
    const cleanText = text.replace(/\*/g, '')
      .replace(/\b(\d+)\b/g, (m, n) => converter.toWords(n))
      .replace(/[\p{Emoji}\p{Emoji_Presentation}\p{Emoji_Modifier_Base}\p{Emoji_Component}]+/gu, '')
      .trim();

    if (!cleanText) return null;

    if (voiceObj.service === 'local') {
      const isWindows = os.platform() === 'win32';
      const piperBinary = path.join(__dirname, 'piper', isWindows ? 'piper.exe' : 'piper');
      const voiceModel = path.join(piperVoicesDir, `${voiceObj.name}.onnx`);
      const voiceConfig = path.join(piperVoicesDir, `${voiceObj.name}.onnx.json`);

      try {
        await fs.access(piperBinary);
        await fs.access(voiceModel);
        await fs.access(voiceConfig);
      } catch (err) {
        throw new Error('Piper binary or voice model/config not found');
      }

      audioFile = `output_${Date.now()}_${index}.wav`;
      const audioFilePath = path.join(audioDir, audioFile);

      return new Promise((resolve, reject) => {
        const piperProcess = spawn(piperBinary, ['--model', voiceModel, '--config', voiceConfig, '--output_file', audioFilePath]);
        let stderrData = '';
        piperProcess.stderr.on('data', data => stderrData += data);
        piperProcess.stdin.write(cleanText);
        piperProcess.stdin.end();
        piperProcess.on('close', code => {
          if (code === 0) resolve(`audio/${audioFile}`);
          else reject(new Error(`Piper failed with code ${code}: ${stderrData}`));
        });
        piperProcess.on('error', reject);
      });
    } else if (voiceObj.service === 'amazon') {
      if (!apiKeys.amazon.accessKeyId || !apiKeys.amazon.secretAccessKey) {
        throw new Error('AWS credentials required');
      }
      const pollyClient = new PollyClient({
        region: process.env.AWS_REGION || 'us-east-1',
        credentials: apiKeys.amazon
      });
      const command = new SynthesizeSpeechCommand({ OutputFormat: 'mp3', Text: cleanText, VoiceId: voiceObj.name });
      const response = await pollyClient.send(command);

      audioFile = `output_${Date.now()}_${index}.mp3`;
      const audioFilePath = path.join(audioDir, audioFile);
      const writeStream = require('fs').createWriteStream(audioFilePath);
      response.AudioStream.pipe(writeStream);

      return new Promise((resolve, reject) => {
        writeStream.on('finish', () => resolve(`audio/${audioFile}`));
        writeStream.on('error', reject);
      });
    } else if (voiceObj.service === 'google') {
      if (!apiKeys.gemini) {
        throw new Error('Google API key required');
      }
      const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKeys.gemini}`;
      const body = {
        input: { text: cleanText },
        voice: { languageCode: voiceObj.lang, name: voiceObj.name },
        audioConfig: { audioEncoding: 'MP3' }
      };
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        throw new Error(`Google TTS error: ${response.status}`);
      }
      const data = await response.json();
      const audioBuffer = Buffer.from(data.audioContent, 'base64');

      audioFile = `output_${Date.now()}_${index}.mp3`;
      const audioFilePath = path.join(audioDir, audioFile);
      await fs.writeFile(audioFilePath, audioBuffer);
      return `audio/${audioFile}`;
    } else {
      throw new Error(`Unknown TTS service: ${voiceObj.service}`);
    }
  }

  app.get('/audio/:filename', async (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(audioDir, filename);
    try {
      res.sendFile(filePath, err => {
        if (err) {
          logger.error(`Failed to send audio file ${filename}:`, err);
          res.status(500).json({ error: 'Failed to send audio file' });
        } else {
          setTimeout(() => {
            fs.unlink(filePath).catch(err => logger.error(`Error deleting audio ${filename}:`, err));
          }, 1000); // Delay deletion to avoid race conditions
        }
      });
    } catch (err) {
      logger.error(`Audio file not found: ${filename}`, err);
      res.status(404).json({ error: 'Audio file not found' });
    }
  });

  app.post('/query', queryLimiter, async (req, res) => {
    let { query, conversationId, model, maxTokens = 200, stream = false, turboMode = false } = req.body;
    const queryError = validateStringInput(query, 1000, 'Query');
    const modelError = validateStringInput(model, 100, 'Model');
    if (queryError || modelError) {
      logger.error('Query validation failed:', queryError || modelError);
      return res.status(400).json({ error: queryError || modelError });
    }
    if (maxTokens && (isNaN(maxTokens) || maxTokens < 1 || maxTokens > 1000)) {
      logger.error('Invalid maxTokens:', maxTokens);
      return res.status(400).json({ error: 'Max tokens must be a number between 1 and 1000' });
    }
    const service = getServiceFromModel(model);
    if (service !== 'ollama' && !apiKeys[service]) {
      logger.error(`API key missing for ${service}`);
      return res.status(403).json({ error: `API key required for ${service}`, service });
    }

    let history = conversationCache.get(conversationId) || [];
    if (!history.length && conversationId) {
      const filePath = path.join(conversationsDir, `${conversationId}.json`);
      try {
        history = JSON.parse(await fs.readFile(filePath, 'utf8'));
        conversationCache.set(conversationId, history);
      } catch (err) {
        logger.warn(`Conversation ${conversationId} not found on disk`);
      }
    }

    if (!conversationId) {
      conversationId = `${sanitizeFilename(query).substring(0, 50) || 'conversation'}_${new Date().toISOString().replace(/[:.]/g, '-')}`;
    }

    // Limit history to last 4 messages to prevent token buildup
    history = history.slice(-4);

    history.push({ role: 'user', content: query });
    let messages = history.map(entry => ({ role: entry.role, content: entry.content }));

    try {
      let answer;
      if (service === 'ollama') {
        const options = maxTokens ? { num_predict: parseInt(maxTokens) } : {};
        
        // Add turbo mode if enabled
        if (turboMode) {
          options.turbo = true;
        }
        
        // Only enable thinking for models that are known to support it
        const supportsThinking = model.toLowerCase().includes('deepseek-r1') || 
                                model.toLowerCase().includes('qwen') ||
                                model.toLowerCase().includes('thinking');
        let body = { model, messages, stream, options };
        if (supportsThinking) {
          body.think = true;
        }
        
        if (stream) {
          // Set up Server-Sent Events for streaming
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Cache-Control',
            'X-Accel-Buffering': 'no' // Disable nginx buffering
          });

          // Send initial connection confirmation
          res.write(': connected\n\n');
          
          // Send server status updates
          res.write(`data: ${JSON.stringify({ 
            serverStatus: `Initializing query for model: ${model}${turboMode ? ' (Turbo Mode)' : ''}`, 
            timestamp: new Date().toISOString() 
          })}\n\n`);
          
          res.write(`data: ${JSON.stringify({ 
            serverStatus: `Query: "${query.substring(0, 100)}${query.length > 100 ? '...' : ''}"`, 
            timestamp: new Date().toISOString() 
          })}\n\n`);
          
          res.write(`data: ${JSON.stringify({ 
            serverStatus: `History length: ${history.length} messages`, 
            timestamp: new Date().toISOString() 
          })}\n\n`);
          
          if (turboMode) {
            res.write(`data: ${JSON.stringify({ 
              serverStatus: `⚡ Turbo mode enabled for faster responses`, 
              timestamp: new Date().toISOString() 
            })}\n\n`);
          }

          let fullResponse = '';
          
          try {
            res.write(`data: ${JSON.stringify({ 
              serverStatus: `Connecting to Ollama API...`, 
              timestamp: new Date().toISOString() 
            })}\n\n`);
            
            const response = await fetch('http://127.0.0.1:11434/api/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
            });
            
            res.write(`data: ${JSON.stringify({ 
              serverStatus: `Ollama responded with status: ${response.status}`, 
              timestamp: new Date().toISOString() 
            })}\n\n`);
            
            if (!response.ok) {
              const errorText = await response.text();
              if (errorText.includes('does not support thinking')) {
                res.write(`data: ${JSON.stringify({ 
                  serverStatus: `Model ${model} doesn't support thinking - retrying without`, 
                  timestamp: new Date().toISOString() 
                })}\n\n`);
                
                logger.info(`Model ${model} does not support thinking; retrying without`);
                body.think = false;
                
                res.write(`data: ${JSON.stringify({ 
                  serverStatus: `Retrying request without thinking capability...`, 
                  timestamp: new Date().toISOString() 
                })}\n\n`);
                
                const retryResponse = await fetch('http://127.0.0.1:11434/api/chat', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(body)
                });
                if (!retryResponse.ok) {
                  throw new Error(`Ollama API error: ${retryResponse.statusText}`);
                }
                
                res.write(`data: ${JSON.stringify({ 
                  serverStatus: `Retry successful - starting stream processing`, 
                  timestamp: new Date().toISOString() 
                })}\n\n`);
                
                await processStreamingResponse(retryResponse, res, history, conversationId);
              } else {
                throw new Error(`Ollama API error: ${response.statusText}`);
              }
            } else {
              res.write(`data: ${JSON.stringify({ 
                serverStatus: `Starting stream processing for successful response`, 
                timestamp: new Date().toISOString() 
              })}\n\n`);
              
              await processStreamingResponse(response, res, history, conversationId);
            }
          } catch (streamError) {
            logger.error(`Streaming error for model ${model}: ${streamError.message}`);
            res.write(`data: ${JSON.stringify({ error: streamError.message, done: true })}\n\n`);
            res.end();
            return;
          }
        } else {
          // Non-streaming mode (original logic)
          let response = await fetch('http://127.0.0.1:11434/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          if (!response.ok) {
            const errorText = await response.text();
            if (errorText.includes('does not support thinking')) {
              logger.info(`Model ${model} does not support thinking; retrying without`);
              body.think = false;
              response = await fetch('http://127.0.0.1:11434/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
              });
            } else {
              logger.error(`Ollama API error for model ${model}: Status ${response.status}, Response: ${errorText}`);
              throw new Error(`Ollama API error: ${response.statusText}`);
            }
          }
          if (!response.ok) {
            const errorText = await response.text();
            logger.error(`Ollama API error for model ${model}: Status ${response.status}, Response: ${errorText}`);
            throw new Error(`Ollama API error: ${response.statusText}`);
          }
          let data = await response.json();
          // Handle various response formats
          let content = null;
          if (Array.isArray(data)) {
            // Concatenate content from array responses
            content = data.map(item => item.message?.content || item.response || '').join(' ').trim();
          } else if (data.message?.content) {
            content = data.message.content;
          } else if (data.response) {
            content = data.response;
          } else if (data.choices && data.choices[0].message.content) {
            content = data.choices[0].message.content;
          }
          if (!content) {
            logger.error(`Invalid Ollama response for model ${model}:`, JSON.stringify(data, null, 2));
            // Try to extract any available text content
            if (typeof data === 'string') {
              content = data;
            } else if (data.error) {
              throw new Error(`Ollama model error: ${data.error}`);
            } else {
              // Last resort - check for any text-like properties
              const possibleContent = data.text || data.output || data.content || '';
              if (possibleContent) {
                content = possibleContent;
              } else {
                answer = 'Model failed to generate a response. Please try again.';
              }
            }
          }
          
          if (content) {
            // Robust regex for <think> tag removal using new RegExp
            const thinkRegex = new RegExp('<think>[^<]*</think>', 'g');
            answer = String(content).replace(thinkRegex, '').trim();
            
            // If answer is empty after think tag removal, provide a fallback
            if (!answer) {
              answer = 'Model generated a response but it was filtered out. Please try again.';
            }
          }
        }
      } else {
        answer = await callExternalAPI(service, model, messages, apiKeys[service], maxTokens);
      }

      if (!stream) {
        history.push({ role: 'assistant', content: answer });
        conversationCache.set(conversationId, history);
        const filePath = path.join(conversationsDir, `${conversationId}.json`);
        await fs.writeFile(filePath, JSON.stringify(history, null, 2)).catch(err => logger.error('Error saving conversation:', err));

        res.json({ response: answer, conversationId });
      }
    } catch (error) {
      if (stream) {
        res.write(`data: ${JSON.stringify({ error: error.message, done: true })}\n\n`);
        res.end();
      } else {
        logger.error(`Query error for model ${model}: ${error.message}`);
        res.status(500).json({ error: `Query error: ${error.message}` });
      }
    }
  });

  app.listen(port, () => logger.info(`Worker ${process.pid} running at http://${localIpAddress}:${port}`));
}