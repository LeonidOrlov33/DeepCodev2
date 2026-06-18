const http = require('http');
const https = require('https');

const OLLAMA_KEY = process.env.OLLAMA_KEY;
const OLLAMA_URL = 'https://ollama.ai/api/openai/v1';
const HF_KEY = process.env.HF_KEY;

const USERS = {
    [process.env.ADMIN_KEY || 'admin-key']: 'Admin',
    [process.env.FRIEND1_KEY || 'friend1']: 'Friend 1',
    [process.env.FRIEND2_KEY || 'friend2']: 'Friend 2'
};

let stats = { total: 0 };

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

function askHF(model, prompt) {
    return new Promise((resolve) => {
        const data = JSON.stringify({
            inputs: prompt,
            parameters: { max_new_tokens: 4000, temperature: 0.7 }
        });

        const options = {
            hostname: 'api-inference.huggingface.co',
            path: '/models/' + model,
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + HF_KEY,
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
                    const text = json[0]?.generated_text || json.generated_text || '[' + model + ' Error]';
                    resolve(text);
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
    console.log('NeuroTeam: Kimi + GPT...');

    // Шаг 1: Kimi анализирует
    const kimi = await askHF('moonshotai/Kimi-K2.7-Code',
        'Задача: ' + prompt + '\nДай подробный анализ и лучшее решение.'
    );

    console.log('Kimi done. GPT synthesizing...');

    // Шаг 2: GPT синтезирует финальный ответ
    const final = await askOllama('gpt-oss:120b:cloud',
        'Ты - эксперт. Синтезируй лучший ответ на основе анализа. Отвечай на русском.',
        'ЗАДАЧА: ' + prompt + '\n\nАНАЛИЗ KIMI:\n' + kimi + '\n\nДай ПОЛНЫЙ финальный ответ.'
    );

    console.log('Done!');
    return { final, models: ['kimi-k2.7-code', 'gpt-oss-120b'] };
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
            team: ['kimi-k2.7-code', 'gpt-oss-120b'],
            providers: ['HuggingFace', 'Ollama Cloud']
        }));
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

                const result = await neuroTeam(prompt);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    id: 'neuro-' + Date.now(),
                    object: 'chat.completion',
                    model: 'neuro-team-v2',
                    choices: [{ index: 0, message: { role: 'assistant', content: result.final }, finish_reason: 'stop' }]
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
server.listen(PORT, () => console.log('DeepCode v2 on port ' + PORT));
