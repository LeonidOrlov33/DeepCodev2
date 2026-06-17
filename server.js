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

// Статистика
let stats = { total: 0, lastRequest: null, uptime: Date.now() };

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
                        resolve('[' + model + ' Error: ' + body.substring(0, 200) + ']');
                    }
                } catch (e) {
                    resolve('[' + model + ' Parse Error]');
                }
            });
        });

        req.on('error', (e) => resolve('[' + model + ' Error: ' + e.message + ']'));
        req.on('timeout', () => { req.destroy(); resolve('[' + model + ' Timeout]'); });
        req.write(data);
        req.end();
    });
}

// Запрос к Cerebras (Llama 70B)
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
                    if (json.choices && json.choices[0]) {
                        resolve(json.choices[0].message.content);
                    } else {
                        resolve('[Cerebras Error: ' + body.substring(0, 200) + ']');
                    }
                } catch (e) {
                    resolve('[Cerebras Parse Error]');
                }
            });
        });

        req.on('error', () => resolve('[Cerebras Error]'));
        req.on('timeout', () => { req.destroy(); resolve('[Cerebras Timeout]'); });
        req.write(data);
        req.end();
    });
}

// Режим: NeuroTeam
async function neuroTeam(prompt) {
    console.log('🧠 NeuroTeam запуск...');

    // Шаг 1: Три модели от Ollama параллельно
    console.log('├─ DeepSeek 671B думает...');
    console.log('├─ Qwen Coder 480B думает...');
    console.log('├─ Gemma 31B думает...');

    const [deepseek, qwen, gemma] = await Promise.all([
        askOllama('deepseek-v3.1:671b:cloud',
            'Ты - DeepSeek V3.1 671B. Анализируй задачу глубоко, проверяй логику, предлагай улучшения. Отвечай на русском.',
            prompt),
        askOllama('qwen3-coder:480b:cloud',
            'Ты - Qwen Coder 480B. Специалист по программированию. Пиши чистый эффективный код с пояснениями. Отвечай на русском.',
            prompt),
        askOllama('gemma4:31b:cloud',
            'Ты - Gemma 4 31B. Подходи к задаче творчески, предлагай альтернативные решения. Отвечай на русском.',
            prompt)
    ]);

    console.log('├─ Три модели ответили');

    // Шаг 2: Cerebras Llama 70B синтезирует
    console.log('├─ Cerebras Llama 70B синтезирует...');

    const final = await askCerebras(
        'Ты - Tech Lead (Llama 70B). Синтезируй лучший ответ на основе мнений команды.\n\n' +
        '═══ ЗАДАЧА ═══\n' + prompt + '\n\n' +
        '═══ DeepSeek 671B (анализ) ═══\n' + deepseek + '\n\n' +
        '═══ Qwen Coder 480B (код) ═══\n' + qwen + '\n\n' +
        '═══ Gemma 31B (творческий подход) ═══\n' + gemma + '\n\n' +
        'Создай ИДЕАЛЬНЫЙ финальный ответ:\n' +
        '1. Возьми лучшие идеи от каждого\n' +
        '2. Исправь ошибки и противоречия\n' +
        '3. Выдай полное, готовое к использованию решение\n' +
        '4. Ответ должен быть на русском языке'
    );

    console.log('✅ Готово!');

    return {
        final_answer: final,
        models: ['deepseek-v3.1:671b', 'qwen3-coder:480b', 'gemma4:31b', 'cerebras-llama3.3-70b'],
        discussion: { deepseek, qwen, gemma }
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
            service: '🧠 DeepCode v2 - NeuroTeam',
            status: 'online',
            team: {
                deepseek: 'DeepSeek V3.1 671B (Ollama)',
                qwen: 'Qwen Coder 480B (Ollama)',
                gemma: 'Gemma 4 31B (Ollama)',
                synthesizer: 'Llama 3.3 70B (Cerebras)'
            },
            uptime_hours: Math.round((Date.now() - stats.uptime) / 3600000),
            total_requests: stats.total
        }));
        return;
    }

    if (req.url === '/stats' && req.method === 'GET') {
        const auth = req.headers.authorization || '';
        if (auth.replace('Bearer ', '') !== process.env.ADMIN_KEY) {
            res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            total_requests: stats.total,
            last_request: stats.lastRequest,
            uptime_hours: Math.round((Date.now() - stats.uptime) / 3600000)
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
                const prompt = data.prompt || data.messages?.[data.messages.length - 1]?.content || '';
                
                stats.total++;
                stats.lastRequest = new Date().toISOString();
                
                console.log('\n' + '='.repeat(60));
                console.log('👤 ' + USERS[key] + ' | 📝 ' + prompt.substring(0, 80) + '...');

                const startTime = Date.now();
                const result = await neuroTeam(prompt);
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

                console.log('⏱ ' + elapsed + 's | 🤖 ' + result.models.join(', '));
                console.log('='.repeat(60) + '\n');

                const response = {
                    success: true,
                    final_answer: result.final_answer,
                    models_used: result.models,
                    time_seconds: parseFloat(elapsed)
                };

                if (data.show_discussion) {
                    response.team_discussion = result.discussion;
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response));
            } catch (e) {
                res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    res.writeHead(404); res.end('Not found');
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log('🧠 DeepCode v2 на порту ' + PORT);
    console.log('👥 Команда: DeepSeek 671B + Qwen 480B + Gemma 31B → Cerebras Llama 70B');
});
