const http = require('http');
const https = require('https');

const OLLAMA_KEY = process.env.OLLAMA_KEY;
const OLLAMA_URL = 'https://ollama.ai/api/openai/v1';

const USERS = {
    [process.env.ADMIN_KEY || 'admin-key']: 'Admin',
    [process.env.FRIEND1_KEY || 'friend1']: 'Friend 1',
    [process.env.FRIEND2_KEY || 'friend2']: 'Friend 2'
};

let stats = { total: 0, lastRequest: null, uptime: Date.now() };

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
                    resolve(json.choices?.[0]?.message?.content || '[' + model + ' Error]');
                } catch (e) {
                    resolve('[' + model + ' Error]');
                }
            });
        });

        req.on('error', () => resolve('[' + model + ' Error]'));
        req.on('timeout', () => { req.destroy(); resolve('[' + model + ' Timeout]'); });
        req.write(data);
        req.end();
    });
}

async function neuroTeam(prompt) {
    console.log('NeuroTeam start...');

    // 3 модели анализируют параллельно
    const [deepseek, qwen, gemma] = await Promise.all([
        askOllama('deepseek-v3.1:671b:cloud', 'Ты DeepSeek. Анализируй глубоко. Отвечай на русском.', prompt),
        askOllama('qwen3-coder:480b:cloud', 'Ты Qwen Coder. Пиши код. Отвечай на русском.', prompt),
        askOllama('gemma4:31b:cloud', 'Ты Gemma. Будь креативным. Отвечай на русском.', prompt)
    ]);

    console.log('3 models done, synthesizing...');

    // GPT-OSS 120B синтезирует
    const final = await askOllama('gpt-oss:120b:cloud',
        'Ты - Tech Lead. Синтезируй лучший ответ на основе мнений команды.',
        'ЗАДАЧА: ' + prompt + '\n\n' +
        '═══ DeepSeek 671B (анализ) ═══\n' + deepseek + '\n\n' +
        '═══ Qwen Coder 480B (код) ═══\n' + qwen + '\n\n' +
        '═══ Gemma 31B (креатив) ═══\n' + gemma + '\n\n' +
        'Создай ИДЕАЛЬНЫЙ финальный ответ на русском языке. Объедини лучшие идеи, исправь ошибки.'
    );

    console.log('Done!');

    return {
        final,
        models: ['deepseek-671b', 'qwen-coder-480b', 'gemma-31b', 'gpt-oss-120b']
    };
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    if (req.url === '/' || req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            service: 'DeepCode v2 - NeuroTeam',
            status: 'online',
            team: ['deepseek-671b', 'qwen-coder-480b', 'gemma-31b', 'gpt-oss-120b'],
            provider: 'Ollama Cloud'
        }));
        return;
    }

    if (req.url === '/stats' && req.method === 'GET') {
        const key = (req.headers.authorization || '').replace('Bearer ', '');
        if (key !== process.env.ADMIN_KEY) { res.writeHead(403); res.end('{}'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats));
        return;
    }

    if ((req.url === '/v1/chat' || req.url === '/v1/chat/completions') && req.method === 'POST') {
        const key = (req.headers.authorization || '').replace('Bearer ', '');
        if (!USERS[key]) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }

        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const prompt = data.prompt || data.messages?.find(m => m.role === 'user')?.content || '';

                stats.total++;
                stats.lastRequest = new Date().toISOString();

                console.log('Request: ' + prompt.substring(0, 50) + '...');
                const startTime = Date.now();
                const result = await neuroTeam(prompt);
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                console.log('Done in ' + elapsed + 's');

                if (req.url === '/v1/chat/completions') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        id: 'neuro-' + Date.now(),
                        object: 'chat.completion',
                        created: Math.floor(Date.now() / 1000),
                        model: 'neuro-team-v2',
                        choices: [{ index: 0, message: { role: 'assistant', content: result.final }, finish_reason: 'stop' }],
                        usage: { prompt_tokens: prompt.length, completion_tokens: result.final.length, total_tokens: prompt.length + result.final.length }
                    }));
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, final_answer: result.final, models_used: result.models, time_seconds: parseFloat(elapsed) }));
                }
            } catch (e) {
                res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    res.writeHead(404); res.end('Not found');
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log('DeepCode v2 on port ' + PORT));
