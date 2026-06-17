const http = require('http');
const https = require('https');

// Конфигурация
const OLLAMA_KEY = process.env.OLLAMA_KEY;
const OLLAMA_URL = 'https://ollama.ai/api/openai/v1';
const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY;

// Пользователи
const USERS = {
    [process.env.ADMIN_KEY || 'admin-key']: 'Admin',
    [process.env.FRIEND1_KEY || 'friend1']: 'Friend 1',
    [process.env.FRIEND2_KEY || 'friend2']: 'Friend 2'
};

// Запрос к Ollama
function askOllama(model, systemPrompt, prompt) {
    return new Promise((resolve) => {
        const data = JSON.stringify({
            model: model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: prompt }
            ],
            temperature: 0.7,
            max_tokens: 4000
        });

        const url = new URL(OLLAMA_URL + '/chat/completions');
        const options = {
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + OLLAMA_KEY,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            },
            timeout: 120000
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    if (json.choices && json.choices[0]) {
                        resolve(json.choices[0].message.content);
                    } else {
                        resolve('[Ollama ' + model + ' Error: ' + body.substring(0, 200) + ']');
                    }
                } catch (e) {
                    resolve('[Ollama Parse Error]');
                }
            });
        });

        req.on('error', (e) => resolve('[Ollama Error: ' + e.message + ']'));
        req.on('timeout', () => { req.destroy(); resolve('[Timeout]'); });
        req.write(data);
        req.end();
    });
}

// Запрос к Cerebras
function askCerebras(prompt) {
    return new Promise((resolve) => {
        const data = JSON.stringify({
            model: 'llama3.3-70b',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 4000,
            temperature: 0.7
        });

        const options = {
            hostname: 'api.cerebras.ai',
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + CEREBRAS_KEY,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            },
            timeout: 60000
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    resolve(json.choices[0].message.content);
                } catch (e) {
                    resolve('[Cerebras Error]');
                }
            });
        });

        req.on('error', () => resolve('[Cerebras Error]'));
        req.on('timeout', () => { req.destroy(); resolve('[Timeout]'); });
        req.write(data);
        req.end();
    });
}

// Режим: NeuroTeam (4 модели → Cerebras синтез)
async function neuroTeam(prompt) {
    console.log('🧠 NeuroTeam запуск...');

    // Запускаем 4 модели параллельно
    const [llama, deepseek, qwen, gemma] = await Promise.all([
        askOllama('llama3.3:70b', 'You are a helpful assistant. Answer in Russian.', prompt),
        askOllama('deepseek-v3.1:671b:cloud', 'You are DeepSeek. Analyze deeply. Answer in Russian.', prompt),
        askOllama('qwen3-coder:480b:cloud', 'You are Qwen Coder. Focus on code and logic. Answer in Russian.', prompt),
        askOllama('gemma4:31b:cloud', 'You are Gemma. Be creative and thorough. Answer in Russian.', prompt)
    ]);

    console.log('4 модели ответили. Cerebras синтезирует...');

    // Cerebras синтезирует
    const final = await askCerebras(
        'Ты - Tech Lead. Синтезируй лучший ответ на основе мнений команды.\n\n' +
        'ЗАДАЧА: ' + prompt + '\n\n' +
        'Llama 70B: ' + llama + '\n\n' +
        'DeepSeek 671B: ' + deepseek + '\n\n' +
        'Qwen Coder 480B: ' + qwen + '\n\n' +
        'Gemma 31B: ' + gemma + '\n\n' +
        'Объедини лучшие идеи, исправь ошибки, выдай ПОЛНЫЙ ответ на русском языке.'
    );

    console.log('✅ Готово!');

    return {
        final_answer: final,
        models: ['llama3.3:70b', 'deepseek-v3.1:671b', 'qwen3-coder:480b', 'gemma4:31b', 'cerebras-llama3.3'],
        discussion: { llama, deepseek, qwen, gemma }
    };
}

// Сервер
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    if (req.url === '/' || req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            service: '🧠 DeepCode v2 - NeuroTeam (4 модели + Cerebras)',
            status: 'online',
            team: ['llama3.3:70b', 'deepseek-v3.1:671b', 'qwen3-coder:480b', 'gemma4:31b', 'cerebras'],
            provider: 'Ollama Cloud + Cerebras'
        }));
        return;
    }

    if ((req.url === '/v1/chat' || req.url === '/v1/chat/completions') && req.method === 'POST') {
        const auth = req.headers.authorization || '';
        const key = auth.replace('Bearer ', '');
        if (!USERS[key]) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }

        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const prompt = data.prompt || data.messages?.[data.messages.length-1]?.content || '';
                console.log('👤 ' + USERS[key] + ': ' + prompt.substring(0, 50) + '...');

                const result = await neuroTeam(prompt);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    final_answer: result.final_answer,
                    models_used: result.models,
                    discussion: data.show_discussion ? result.discussion : undefined
                }));
            } catch (e) {
                res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    res.writeHead(404); res.end('Not found');
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log('🧠 DeepCode v2 на порту ' + PORT));
